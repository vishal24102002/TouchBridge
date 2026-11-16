
## Audio sharing

The host can share its microphone or system sound (Settings → Audio, off by default). Audio chunks
(`"TBA1"` + channels u8 + sample-rate u32 BE + PCM16LE) arrive on stdin like video frames and are kept
in a separate lane of `FrameBuffer`, so they never disturb the video GOP logic. Each viewer receives
them on the same stream connection; a viewer that lags simply loses the oldest chunks.
