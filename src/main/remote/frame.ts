const FRAME_HEADER_BYTES = 4;

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value) ?? 'null', 'utf8');
  if (body.length > MAX_FRAME_BYTES) {
    throw new FrameError(`frame too large to send: ${body.length} bytes`);
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): readonly unknown[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      if (this.buffered.length < FRAME_HEADER_BYTES) break;
      const length = this.buffered.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new FrameError(`frame too large to read: ${length} bytes`);
      }
      const end = FRAME_HEADER_BYTES + length;
      if (this.buffered.length < end) break;
      const body = this.buffered.subarray(FRAME_HEADER_BYTES, end);
      this.buffered = this.buffered.subarray(end);
      try {
        messages.push(JSON.parse(body.toString('utf8')) as unknown);
      } catch (error) {
        throw new FrameError(`frame is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return messages;
  }

  get pending(): number {
    return this.buffered.length;
  }
}
