import { router } from 'expo-router';

/**
 * Goes back, or to the feed when there is nowhere to go back to.
 *
 * `router.back()` is a no-op with an empty history stack, which is the normal
 * case on web: opening /cart from a link or a bookmark, or reloading the page,
 * leaves nothing behind it. The button then does nothing at all, which reads as
 * broken rather than as "there is no previous screen".
 *
 * The feed is the right destination because it is the app's home — every other
 * screen is something you opened from it.
 */
export function goBackOrFeed(): void {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/');
}
