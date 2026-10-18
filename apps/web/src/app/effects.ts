// When effects run. Preact runs them after the next animation frame. The app's effects (a store's subscription, catching up on a
// change made since the render, the `tfus` mark) were written for React, which runs the effects of a render a store update caused
// (useSyncExternalStore, a sync render) at the end of that commit, before the browser lays out and paints. So Preact runs them
// right after the commit too: a microtask. (A task would let the browser lay out and paint the frame first, and every effect, the
// `tfus` mark among them, would wait for that frame.)
import { options } from "preact";

options.requestAnimationFrame = (flush) => queueMicrotask(flush);
