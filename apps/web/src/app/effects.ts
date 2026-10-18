// When effects run. Preact runs them after the next animation frame; React runs them in a task right after the commit. The app's
// effects (a store's subscription, catching up on a change made since the render, the `tfus` mark) were written for React's
// timing, and each one Preact holds for a frame delays what follows it, so Preact is given React's: a task after the commit.
import { options } from "preact";

const channel = new MessageChannel();
let queued: (() => void)[] = [];
channel.port1.onmessage = () => {
  const run = queued;
  queued = [];
  for (const flush of run) flush();
};

options.requestAnimationFrame = (flush) => {
  queued.push(flush);
  if (queued.length === 1) channel.port2.postMessage(null);
};
