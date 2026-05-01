/**
 * AWS Event Stream binary frame parser.
 *
 * @see https://docs.aws.amazon.com/event-stream/latest/api-reference/eventstream-binary-format.html
 *
 * Frame layout (big-endian):
 *   [4 bytes total_length] [4 bytes headers_length] [4 bytes prelude_crc]
 *   [headers…] [payload…] [4 bytes message_crc]
 *
 * Header entry layout:
 *   [1 byte name_len] [name…] [1 byte type] [value…]
 */

// Header value types
const HEADER_TYPE_TRUE = 0x00;
const HEADER_TYPE_FALSE = 0x01;
const HEADER_TYPE_BYTE = 0x02;
const HEADER_TYPE_SHORT = 0x03;
const HEADER_TYPE_INT = 0x04;
const HEADER_TYPE_LONG = 0x05;
const HEADER_TYPE_BYTE_ARRAY = 0x06;
const HEADER_TYPE_STRING = 0x07;
const HEADER_TYPE_TIMESTAMP = 0x08;
const HEADER_TYPE_UUID = 0x09;
const MIN_FRAME_LENGTH = 16;
const PRELUDE_LENGTH = 12;
const MESSAGE_CRC_LENGTH = 4;
const HEADER_DECODER = new TextDecoder();

export interface EventStreamMessage {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Uint8Array;
}

function readUint16BE(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

function readUint32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function parseInt64BE(view: DataView, offset: number): number {
  // Read as two 32-bit halves to avoid BigInt issues
  const high = view.getInt32(offset, false);
  const low = view.getUint32(offset + 4, false);
  return high * 0x100000000 + low;
}

function decodeHeader(
  data: Uint8Array,
  offset: number,
): { name: string; value: string | number | boolean | Uint8Array; bytesRead: number } {
  if (offset >= data.length) {
    throw new Error('Event stream header is truncated before name length');
  }

  const nameLen = data[offset];
  offset += 1;
  if (offset + nameLen > data.length) {
    throw new Error('Event stream header name exceeds frame length');
  }

  const name = HEADER_DECODER.decode(data.slice(offset, offset + nameLen));
  offset += nameLen;

  if (offset >= data.length) {
    throw new Error(`Event stream header "${name}" is truncated before type`);
  }

  const type = data[offset];
  offset += 1;
  const remaining = data.length - offset;

  switch (type) {
    case HEADER_TYPE_TRUE:
      return { name, value: true, bytesRead: 2 + nameLen };
    case HEADER_TYPE_FALSE:
      return { name, value: false, bytesRead: 2 + nameLen };
    case HEADER_TYPE_BYTE:
      if (remaining < 1) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      return { name, value: data[offset], bytesRead: 3 + nameLen };
    case HEADER_TYPE_SHORT:
      if (remaining < 2) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      return { name, value: readUint16BE(new DataView(data.buffer, data.byteOffset + offset), 0), bytesRead: 4 + nameLen };
    case HEADER_TYPE_INT:
      if (remaining < 4) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      return { name, value: readUint32BE(new DataView(data.buffer, data.byteOffset + offset), 0), bytesRead: 6 + nameLen };
    case HEADER_TYPE_LONG:
      if (remaining < 8) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      return { name, value: parseInt64BE(new DataView(data.buffer, data.byteOffset + offset), 0), bytesRead: 10 + nameLen };
    case HEADER_TYPE_BYTE_ARRAY: {
      if (remaining < 2) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      const len = readUint16BE(new DataView(data.buffer, data.byteOffset + offset), 0);
      if (remaining < 2 + len) {
        throw new Error(`Event stream header "${name}" byte array exceeds frame length`);
      }
      return { name, value: data.slice(offset + 2, offset + 2 + len), bytesRead: 4 + nameLen + len };
    }
    case HEADER_TYPE_STRING: {
      if (remaining < 2) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      const len = readUint16BE(new DataView(data.buffer, data.byteOffset + offset), 0);
      if (remaining < 2 + len) {
        throw new Error(`Event stream header "${name}" string exceeds frame length`);
      }
      const value = HEADER_DECODER.decode(data.slice(offset + 2, offset + 2 + len));
      return { name, value, bytesRead: 4 + nameLen + len };
    }
    case HEADER_TYPE_TIMESTAMP:
      if (remaining < 8) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      return { name, value: parseInt64BE(new DataView(data.buffer, data.byteOffset + offset), 0), bytesRead: 10 + nameLen };
    case HEADER_TYPE_UUID:
      if (remaining < 16) {
        throw new Error(`Event stream header "${name}" is truncated`);
      }
      return { name, value: data.slice(offset, offset + 16), bytesRead: 18 + nameLen };
    default:
      throw new Error(`Unknown header type: 0x${type.toString(16)}`);
  }
}

/**
 * Parse a single event stream frame from a Uint8Array at the given offset.
 * Returns the parsed message and the total number of bytes consumed.
 */
export function parseEventStreamFrame(
  data: Uint8Array,
  offset: number,
): { message: EventStreamMessage; bytesRead: number } | undefined {
  // Minimum frame: 4 total_len + 4 headers_len + 4 prelude_crc + 4 msg_crc = 16 bytes
  if (data.length - offset < MIN_FRAME_LENGTH) {
    return undefined;
  }

  const view = new DataView(data.buffer, data.byteOffset + offset);
  const totalLength = readUint32BE(view, 0);
  const headersLength = readUint32BE(view, 4);

  if (totalLength < MIN_FRAME_LENGTH) {
    throw new Error(`Invalid event stream frame length: ${totalLength}`);
  }
  if (data.length - offset < totalLength) {
    return undefined;
  }
  if (headersLength > totalLength - MIN_FRAME_LENGTH) {
    throw new Error(
      `Invalid event stream headers length ${headersLength} for frame length ${totalLength}`,
    );
  }

  // Parse headers — they start after the 12-byte prelude (4 total + 4 headers + 4 prelude_crc)
  const headers: Record<string, string | number | boolean | Uint8Array> = {};
  let headerOffset = offset + PRELUDE_LENGTH;
  const headersEnd = offset + PRELUDE_LENGTH + headersLength;

  while (headerOffset < headersEnd) {
    const result = decodeHeader(data, headerOffset);
    headers[result.name] = result.value;
    headerOffset += result.bytesRead;
  }

  // Extract payload (between headers and trailing 4-byte message CRC)
  const payloadStart = headersEnd;
  const payloadEnd = offset + totalLength - MESSAGE_CRC_LENGTH;
  const payload = data.slice(payloadStart, payloadEnd);

  return {
    message: { headers, payload },
    bytesRead: totalLength,
  };
}

/**
 * Parse all complete event stream frames from a buffer.
 * Returns parsed messages and the number of bytes consumed from the buffer start.
 */
export function parseEventStreamFrames(
  data: Uint8Array,
): { messages: EventStreamMessage[]; bytesConsumed: number } {
  const messages: EventStreamMessage[] = [];
  let offset = 0;

  while (offset < data.length) {
    const result = parseEventStreamFrame(data, offset);
    if (!result) {
      break;
    }
    messages.push(result.message);
    offset += result.bytesRead;
  }

  return { messages, bytesConsumed: offset };
}
