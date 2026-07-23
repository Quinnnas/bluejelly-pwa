/* Locks the outer page so it behaves like a fixed app screen instead of a
   scrollable webpage — this is what stops the iOS Safari "rubber-band"
   bounce/drag when you swipe near the top or bottom of the screen.
   Elements inside the app that need their own scrolling (Settings,
   Reports, etc.) already use overflowY:"auto" and are unaffected —
   this only locks the outer html/body/#root. */

html, body {
  height: 100%;
  width: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  position: fixed;
  inset: 0;
  overscroll-behavior: none;
  background: #0C0F14;
  -webkit-text-size-adjust: 100%;
}

#root {
  height: 100%;
  width: 100%;
  overflow: hidden;
  position: fixed;
  inset: 0;
}

/* Prevent the double-tap-to-zoom / long-press callouts that make a page
   feel like a browser tab rather than an app. */
* {
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}

input, textarea {
  -webkit-user-select: text;
  user-select: text;
}

/* Hide the visible scrollbar track everywhere in the app — scrolling still
   works normally, it just doesn't show a bar, matching how a real mobile
   app never shows scrollbar chrome. */
* {
  scrollbar-width: none; /* Firefox */
}
*::-webkit-scrollbar {
  display: none; /* Chrome, Safari, Edge */
}
