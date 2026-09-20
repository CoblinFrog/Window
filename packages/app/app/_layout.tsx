import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { COLORS } from '@window/shared';
import { setEventSession, startEventLoop } from '../src/store/events.js';
import { setFeedSessionId } from '../src/store/feed.js';
import { useSession } from '../src/store/session.js';

/**
 * The app shell.
 *
 * There is no persistent header and no tab bar. The feed is the app — any
 * standing navigation would imply the feed is one section of something larger,
 * which is the impression this product cannot afford to give.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Catalog documents are CDN-fronted and change on a crawl cadence, not a
      // user one; refetching them on every focus buys nothing.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout(): React.ReactElement {
  const session = useSession();

  useEffect(() => {
    void session.boot();
  }, []);

  // The session id ties the feed's paging and the event batch together, so both
  // stores are told about it the moment the bootstrap lands.
  useEffect(() => {
    const id = session.session?.sessionId;
    if (!id) return;
    setFeedSessionId(id);
    setEventSession(id);
  }, [session.session?.sessionId]);

  useEffect(() => startEventLoop(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <View style={styles.root}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: COLORS.surface },
            animation: 'fade',
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="onboarding" />
          {/* Sheet-style presentation for everything that is not the feed: the
              feed is never unmounted, only covered. */}
          <Stack.Screen name="cart" options={{ presentation: 'modal' }} />
          <Stack.Screen name="checkout" options={{ presentation: 'modal' }} />
          <Stack.Screen name="orders" options={{ presentation: 'modal' }} />
        </Stack>
      </View>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.surface },
});
