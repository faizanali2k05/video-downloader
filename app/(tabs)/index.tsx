import { Video } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';

type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';

type DownloadItem = {
  id: string;
  url: string;
  fileUri: string;
  progress: number;
  status: DownloadStatus;
  savedToGallery: boolean;
  assetId?: string;
  error?: string;
};

const STORAGE_KEY = '@video_downloader_downloads';

const isValidUrl = (value: string) => /^https?:\/\//i.test(value);
const isYoutubeUrl = (value: string) => /(?:youtube\.com|youtu\.be)\//i.test(value);

const resolveYoutubeStream = async (videoUrl: string): Promise<string> => {
  // This is a placeholder. Implement your own yt-dlp API in production.
  try {
    const response = await fetch(`https://your-backend.example.com/extract?url=${encodeURIComponent(videoUrl)}`);
    const data = await response.json();

    if (!response.ok || !data?.directUrl) {
      throw new Error(data?.message || 'Could not resolve YouTube stream URL');
    }

    return data.directUrl;
  } catch (error) {
    console.log('[yt-dlp] resolve error', error);
    throw new Error('Could not resolve direct video URL. Ensure backend is running.');
  }
};

export default function HomeScreen() {
  const deviceScheme = useColorScheme();
  const [themeOverride, setThemeOverride] = useState<'light' | 'dark' | null>(null);
  const colorScheme = themeOverride ?? deviceScheme ?? 'light';

  const [url, setUrl] = useState('');
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [mediaPermission, setMediaPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');

  const downloadRefs = useRef<Record<string, FileSystem.DownloadResumable>>({});

  useEffect(() => {
    const init = async () => {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      setMediaPermission(status === 'granted' ? 'granted' : 'denied');

      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          setDownloads(JSON.parse(saved));
        } catch (error) {
          console.log('Failed to parse saved downloads', error);
        }
      }
    };

    init();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(downloads)).catch((error) => {
      console.log('Failed to persist downloads', error);
    });
  }, [downloads]);

  const setTheme = (value: 'light' | 'dark' | null) => setThemeOverride(value);

  const pasteFromClipboard = async () => {
    const clipboardContent = await Clipboard.getStringAsync();

    if (!clipboardContent) {
      return Alert.alert('Clipboard empty', 'No URL was found in clipboard.');
    }

    setUrl(clipboardContent.trim());
    Alert.alert('Pasted', 'URL was pasted from clipboard.');
  };

  const saveToGallery = async (fileUri: string, id: string) => {
    try {
      const asset = await MediaLibrary.createAssetAsync(fileUri);
      const album = await MediaLibrary.getAlbumAsync('VideoDownloader');

      if (album) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
      } else {
        await MediaLibrary.createAlbumAsync('VideoDownloader', asset, false);
      }

      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                savedToGallery: true,
                assetId: asset.id,
              }
            : item
        )
      );
    } catch (error) {
      console.log('Save to gallery failed:', error);
    }
  };

  const deleteDownload = async (item: DownloadItem) => {
    try {
      if (item.assetId) {
        await MediaLibrary.removeAssetsAsync([item.assetId]);
      }

      await FileSystem.deleteAsync(item.fileUri, { idempotent: true });

      setDownloads((prev) => prev.filter((d) => d.id !== item.id));
      if (selectedVideo === item.fileUri) {
        setSelectedVideo(null);
      }

      Alert.alert('Deleted', 'Download has been removed.');
    } catch (error) {
      console.log('Delete error', error);
      Alert.alert('Delete failed', (error as Error).message || 'Unable to delete file.');
    }
  };

  const getDirectUrl = async (candidateUrl: string) => {
    if (isYoutubeUrl(candidateUrl)) {
      return await resolveYoutubeStream(candidateUrl);
    }

    return candidateUrl;
  };

  const startDownload = async () => {
    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      return Alert.alert('Error', 'Please enter a URL.');
    }

    if (!isValidUrl(trimmedUrl)) {
      return Alert.alert('Invalid URL', 'Please enter a valid http:// or https:// URL.');
    }

    const id = `${Date.now()}`;
    const filename = `video_${id}.mp4`;
    const fileUri = FileSystem.documentDirectory + filename;

    setDownloads((prev) => [
      {
        id,
        url: trimmedUrl,
        fileUri,
        progress: 0,
        status: 'downloading',
        savedToGallery: false,
      },
      ...prev,
    ]);

    try {
      const sourceUrl = await getDirectUrl(trimmedUrl);
      const downloadResumable = FileSystem.createDownloadResumable(
        sourceUrl,
        fileUri,
        {},
        (downloadProgress) => {
          const progress =
            downloadProgress.totalBytesExpectedToWrite > 0
              ? downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite
              : 0;

          setDownloads((prevDownloads) =>
            prevDownloads.map((item) =>
              item.id === id
                ? {
                    ...item,
                    progress,
                  }
                : item
            )
          );
        }
      );

      downloadRefs.current[id] = downloadResumable;

      const { uri } = await downloadResumable.downloadAsync();

      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                fileUri: uri,
                progress: 1,
                status: 'completed',
              }
            : item
        )
      );

      if (mediaPermission === 'granted') {
        await saveToGallery(uri, id);
      }

      setUrl('');
    } catch (error: any) {
      console.log('Download error:', error);
      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'failed',
                error: error?.message || 'Download failed',
              }
            : item
        )
      );
      Alert.alert('Download failed', error?.message || 'An unknown error occurred.');
    }
  };

  const pauseDownload = async (id: string) => {
    const resumable = downloadRefs.current[id];
    if (!resumable) return;

    try {
      await resumable.pauseAsync();
      setDownloads((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: 'paused' } : item))
      );
    } catch (error) {
      console.log('Pause error', error);
    }
  };

  const resumeDownload = async (id: string) => {
    const resumable = downloadRefs.current[id];
    if (!resumable) return;

    try {
      setDownloads((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status: 'downloading' } : item))
      );

      const { uri } = await resumable.resumeAsync();

      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                fileUri: uri,
                progress: 1,
                status: 'completed',
              }
            : item
        )
      );

      if (mediaPermission === 'granted') {
        await saveToGallery(uri, id);
      }
    } catch (error: any) {
      console.log('Resume error', error);
      setDownloads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'failed',
                error: error?.message || 'Resume failed',
              }
            : item
        )
      );
    }
  };

  const retryDownload = async (item: DownloadItem) => {
    setUrl(item.url);
    await startDownload();
  };

  const themeColors = {
    light: {
      background: '#fff',
      text: '#000',
      border: '#888',
      card: '#f8f8f8',
    },
    dark: {
      background: '#050505',
      text: '#fff',
      border: '#444',
      card: '#111',
    },
  };

  const colors = themeColors[colorScheme];

  const styled = {
    container: [styles.container, { backgroundColor: colors.background }],
    heading: [styles.heading, { color: colors.text }],
    input: [styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }],
    statusText: [styles.statusText, { color: colors.text }],
    itemContainer: [styles.itemContainer, { borderColor: colors.border, backgroundColor: colors.card }],
    itemTitle: [styles.itemTitle, { color: colors.text }],
    itemSub: [styles.itemSub, { color: colors.text }],
    tip: [styles.tip, { color: colors.text }],
  };

  const activeDownloadsCount = downloads.filter((item) => item.status === 'downloading').length;

  return (
    <View style={styled.container}>
      <Text style={styled.heading}>Video Downloader</Text>
      <View style={styles.switchRow}>
        <Button
          title="Light"
          onPress={() => setTheme('light')}
          color={colorScheme === 'light' ? '#1d4ed8' : '#888'}
        />
        <Button
          title="System"
          onPress={() => setTheme(null)}
          color={!themeOverride ? '#1d4ed8' : '#888'}
        />
        <Button
          title="Dark"
          onPress={() => setTheme('dark')}
          color={colorScheme === 'dark' ? '#1d4ed8' : '#888'}
        />
      </View>

      <TextInput
        placeholder="Enter video URL"
        placeholderTextColor={colorScheme === 'dark' ? '#aaa' : '#666'}
        value={url}
        onChangeText={setUrl}
        style={styled.input}
        autoCapitalize="none"
        keyboardType="url"
      />
      <View style={styles.buttonRow}>
        <Button title="Paste URL" onPress={pasteFromClipboard} />
        <Button title="Download" onPress={startDownload} />
      </View>

      <View style={styles.statusBar}>
        <Text style={styled.statusText}>Media: {mediaPermission}</Text>
        <Text style={styled.statusText}>{activeDownloadsCount} downloading</Text>
      </View>

      <FlatList
        data={downloads}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={({ item }) => (
          <View style={styled.itemContainer}>
            <TouchableOpacity onPress={() => item.status === 'completed' && setSelectedVideo(item.fileUri)}>
              <Text style={styled.itemTitle} numberOfLines={1}>
                {item.url}
              </Text>
            </TouchableOpacity>
            <Text style={styled.itemSub}>
              {Item status: {item.status.toUpperCase()} {item.savedToGallery ? '(saved)' : ''}
            </Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} />
            </View>
            {item.error ? <Text style={styles.errorText}>{item.error}</Text> : null}
            <View style={styles.actionsRow}>
              {item.status === 'downloading' && <Button title="Pause" onPress={() => pauseDownload(item.id)} />}
              {item.status === 'paused' && <Button title="Resume" onPress={() => resumeDownload(item.id)} />}
              {(item.status === 'failed' || item.status === 'completed') && (
                <Button title="Delete" color="red" onPress={() => deleteDownload(item)} />
              )}
              {item.status === 'failed' && <Button title="Retry" onPress={() => retryDownload(item)} />}
            </View>
          </View>
        )}
      />

      {selectedVideo ? (
        <View style={styles.playerContainer}>
          <Text style={[styles.playerTitle, { color: colors.text }]}>Playback</Text>
          <Video source={{ uri: selectedVideo }} useNativeControls resizeMode="contain" style={styles.video} />
          <Button title="Close Player" onPress={() => setSelectedVideo(null)} />
        </View>
      ) : (
        <Text style={styled.tip}>Tap a completed item to play it.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 12,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  statusBar: {
    marginTop: 10,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statusText: {
    fontSize: 12,
  },
  list: {
    marginBottom: 8,
  },
  itemContainer: {
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  itemTitle: {
    fontWeight: '600',
    fontSize: 13,
  },
  itemSub: {
    fontSize: 12,
    marginBottom: 6,
  },
  progressTrack: {
    height: 8,
    width: '100%',
    backgroundColor: '#eee',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#4a90e2',
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  errorText: {
    color: 'red',
    marginTop: 4,
  },
  playerContainer: {
    marginTop: 12,
  },
  playerTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  video: {
    width: '100%',
    height: 220,
    backgroundColor: '#000',
    marginBottom: 6,
  },
  tip: {
    padding: 8,
  },
});
