package mijia.bridge;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Owned, bounded G.711 A-law and Ogg/Opus framing. It never decodes or stores camera content on disk. */
final class AudioCodecs {
    static final int MAX_PACKET = 16384;
    private AudioCodecs() { }

    static short decodeAlaw(byte value) {
        int a = (value & 255) ^ 0x55;
        int t = (a & 15) << 4, segment = (a & 0x70) >>> 4;
        if (segment == 0) t += 8;
        else { t += 0x108; if (segment > 1) t <<= segment - 1; }
        return (short) ((a & 0x80) != 0 ? t : -t);
    }

    static byte encodeAlaw(short value) {
        int pcm = value, mask;
        if (pcm >= 0) mask = 0xD5;
        else { mask = 0x55; pcm = -pcm - 1; }
        pcm = Math.min(pcm, 32767);
        int segment = 0;
        for (int end = 0xFF; segment < 8 && pcm > end; segment++, end = (end << 1) | 1) { }
        if (segment >= 8) return (byte) (0x7F ^ mask);
        int a = (segment << 4) | ((pcm >>> (segment < 2 ? 4 : segment + 3)) & 15);
        return (byte) (a ^ mask);
    }

    static byte[] pcmFromAlaw(byte[] bytes) {
        if (bytes.length > MAX_PACKET) throw new IllegalArgumentException("audio_packet_size");
        ByteBuffer out = ByteBuffer.allocate(bytes.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (byte value : bytes) out.putShort(decodeAlaw(value));
        return out.array();
    }

    static byte[] wavHeader(int sampleRate) {
        if (sampleRate != 8000 && sampleRate != 16000) throw new IllegalArgumentException("audio_rate");
        ByteBuffer out = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(-1);
        out.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        out.putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16);
        out.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(-1);
        return out.array();
    }

    /** RFC 6716 section 3: samples represented by an Opus packet at the 48 kHz clock. */
    static int opusSamples(byte[] packet) {
        if (packet.length == 0 || packet.length > MAX_PACKET) throw new IllegalArgumentException("opus_packet_size");
        int toc = packet[0] & 255, config = toc >>> 3, frame;
        if (config >= 16) frame = 120 << (config & 3);
        else if (config >= 12) frame = 480 << (config & 1);
        else frame = switch (config & 3) { case 0 -> 480; case 1 -> 960; case 2 -> 1920; default -> 2880; };
        int count = switch (toc & 3) {
            case 0 -> 1;
            case 1, 2 -> 2;
            default -> packet.length >= 2 ? packet[1] & 63 : 0;
        };
        int samples = frame * count;
        if (count == 0 || samples > 5760) throw new IllegalArgumentException("opus_duration");
        return samples;
    }

    static int oggCrc(byte[] bytes) {
        int crc = 0;
        for (byte value : bytes) {
            crc ^= (value & 255) << 24;
            for (int bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        }
        return crc;
    }

    static final class OggWriter {
        private final int serial;
        private int sequence;
        private long samples;
        OggWriter(int serial) { this.serial = serial; }
        byte[] headers() {
            ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
            head.put("OpusHead".getBytes(StandardCharsets.US_ASCII)).put((byte) 1).put((byte) 2);
            head.putShort((short) 0).putInt(48000).putShort((short) 0).put((byte) 0);
            byte[] vendor = "mijia-homebridge".getBytes(StandardCharsets.US_ASCII);
            ByteBuffer tags = ByteBuffer.allocate(16 + vendor.length).order(ByteOrder.LITTLE_ENDIAN);
            tags.put("OpusTags".getBytes(StandardCharsets.US_ASCII)).putInt(vendor.length).put(vendor).putInt(0);
            byte[] first = page(head.array(), 2, 0), second = page(tags.array(), 0, 0);
            byte[] result = Arrays.copyOf(first, first.length + second.length);
            System.arraycopy(second, 0, result, first.length, second.length);
            return result;
        }
        byte[] packet(byte[] bytes) {
            samples += opusSamples(bytes);
            return page(bytes, 0, samples);
        }
        private byte[] page(byte[] packet, int flags, long granule) {
            if (packet.length > MAX_PACKET) throw new IllegalArgumentException("ogg_packet_size");
            int segments = packet.length / 255 + 1;
            ByteBuffer page = ByteBuffer.allocate(27 + segments + packet.length).order(ByteOrder.LITTLE_ENDIAN);
            page.put("OggS".getBytes(StandardCharsets.US_ASCII)).put((byte) 0).put((byte) flags).putLong(granule);
            page.putInt(serial).putInt(sequence++).putInt(0).put((byte) segments);
            for (int left = packet.length, i = 0; i < segments; i++) { int n = Math.min(255, left); page.put((byte) n); left -= n; }
            page.put(packet);
            byte[] result = page.array();
            ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN).putInt(22, oggCrc(result));
            return result;
        }
    }

    /** A bounded Ogg demuxer for the local FFmpeg talkback POST, not arbitrary remote media. */
    static final class OggReader {
        private final InputStream input;
        private final ByteArrayOutputStream partial = new ByteArrayOutputStream();
        private final List<byte[]> ready = new ArrayList<>();
        private Integer serial;
        private int sequence, headers;
        OggReader(InputStream input) { this.input = input; }
        byte[] next() throws IOException {
            for (;;) {
                if (!ready.isEmpty()) return ready.remove(0);
                byte[] header = input.readNBytes(27);
                if (header.length == 0) {
                    if (partial.size() != 0) throw new EOFException("ogg_truncated");
                    return null;
                }
                if (header.length != 27 || !Arrays.equals(Arrays.copyOf(header, 4), "OggS".getBytes(StandardCharsets.US_ASCII)) || header[4] != 0)
                    throw new IOException("ogg_header");
                int flags = header[5] & 255;
                if ((flags & ~7) != 0 || ((flags & 1) != 0) != (partial.size() != 0)) throw new IOException("ogg_continuation");
                ByteBuffer fields = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);
                int currentSerial = fields.getInt(14), currentSequence = fields.getInt(18), crc = fields.getInt(22);
                if (serial == null) { if (currentSequence != 0 || (flags & 2) == 0) throw new IOException("ogg_begin"); serial = currentSerial; }
                if (serial != currentSerial || currentSequence != sequence++) throw new IOException("ogg_sequence");
                int count = header[26] & 255;
                byte[] lacing = input.readNBytes(count);
                if (lacing.length != count) throw new EOFException("ogg_truncated");
                int size = 0; for (byte value : lacing) size += value & 255;
                if (size > 65536) throw new IOException("ogg_page_size");
                byte[] body = input.readNBytes(size);
                if (body.length != size) throw new EOFException("ogg_truncated");
                byte[] page = new byte[27 + count + size];
                System.arraycopy(header, 0, page, 0, 27); Arrays.fill(page, 22, 26, (byte) 0);
                System.arraycopy(lacing, 0, page, 27, count); System.arraycopy(body, 0, page, 27 + count, size);
                if (oggCrc(page) != crc) throw new IOException("ogg_crc");
                int offset = 0;
                for (byte value : lacing) {
                    int length = value & 255;
                    if (partial.size() + length > MAX_PACKET) throw new IOException("ogg_packet_size");
                    partial.write(body, offset, length); offset += length;
                    if (length < 255) {
                        byte[] packet = partial.toByteArray(); partial.reset();
                        if (headers == 0) {
                            if (packet.length < 19 || !starts(packet, "OpusHead") || packet[8] != 1 || packet[9] != 2 || packet[18] != 0)
                                throw new IOException("opus_header");
                            headers++;
                        } else if (headers == 1) {
                            if (!starts(packet, "OpusTags")) throw new IOException("opus_tags");
                            headers++;
                        } else {
                            try { opusSamples(packet); } catch (IllegalArgumentException invalid) { throw new IOException("opus_packet"); }
                            ready.add(packet);
                        }
                    }
                }
            }
        }
        private static boolean starts(byte[] packet, String value) {
            byte[] prefix = value.getBytes(StandardCharsets.US_ASCII);
            return packet.length >= prefix.length && Arrays.equals(Arrays.copyOf(packet, prefix.length), prefix);
        }
    }
}
