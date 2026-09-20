import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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
    // The feed itself stays edge-to-edge; the provider is here for the layers
    // that anchor to a screen edge and would otherwise land under a notch.
    <SafeAreaProvider>
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
          {/* The cart comes in from the right, like a page pushed onto a
              stack. `animation: 'slide_from_right'` is the obvious way to ask
              for that and it does nothing here: it is a native-stack option,
              and on the web the navigator drops it — measured, the transition
              produced no transform, no class change and no keyframe. So the
              screen animates itself, which also means one implementation
              rather than a native one and a web one that drift apart. */}
          <Stack.Screen name="cart" options={{ presentation: 'card', animation: 'none' }} />
          <Stack.Screen name="checkout" options={{ presentation: 'modal' }} />
          <Stack.Screen name="orders" options={{ presentation: 'modal' }} />
        </Stack>
      </View>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.surface },
});
