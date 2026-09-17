/** Regression: preview cancellation must reach both Node and Web source streams. */
import { PassThrough } from "node:stream";
import {
  nodeStreamToBuffer,
  renderImagePreview,
  webStreamToBuffer,
} from "../../apps/web/src/lib/image-preview.ts";

async function expectAbort(label, run) {
  try {
    await run();
    throw new Error(`${label} did not abort`);
  } catch (error) {
    if (!String(error).includes("preview abort regression")) throw error;
    console.log(`PASS | ${label}`);
  }
}

await expectAbort("Node stream is destroyed on abort", async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const pending = nodeStreamToBuffer(stream, 1024, controller.signal);
  setTimeout(
    () => controller.abort(new Error("preview abort regression")),
    25,
  );
  await pending;
});

let webCancelled = false;
await expectAbort("Web stream reader is cancelled on abort", async () => {
  let interval;
  const stream = new ReadableStream({
    start(controller) {
      interval = setInterval(
        () => controller.enqueue(new Uint8Array([1, 2, 3])),
        5,
      );
    },
    cancel() {
      webCancelled = true;
      clearInterval(interval);
    },
  });
  const controller = new AbortController();
  const pending = webStreamToBuffer(stream, 1024, controller.signal);
  setTimeout(
    () => controller.abort(new Error("preview abort regression")),
    25,
  );
  await pending;
});
if (!webCancelled) throw new Error("Web stream cancel hook was not called");

let oversizedCancelled = false;
const oversized = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3, 4]));
  },
  cancel() {
    oversizedCancelled = true;
  },
});
try {
  await webStreamToBuffer(oversized, 3);
  throw new Error("oversized Web stream did not fail");
} catch (error) {
  if (!String(error).includes("exceeds preview limit")) throw error;
}
if (!oversizedCancelled)
  throw new Error("oversized Web stream was not cancelled");
console.log("PASS | oversized Web stream is cancelled");

await expectAbort("Sharp is not started after abort", async () => {
  const controller = new AbortController();
  controller.abort(new Error("preview abort regression"));
  await renderImagePreview(Buffer.from("not-an-image"), 768, controller.signal);
});
