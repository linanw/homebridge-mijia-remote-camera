package mijia.bridge;

import micam.miss.MissClient;
import micam.miss.MissCrypto;
import micam.pppp.Frame;
import micam.pppp.Msg;
import micam.pppp.PpppConnection;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/** Own MISS channel-3 sender; uses the established encrypted session and no extra cloud connection. */
final class Talkback implements AutoCloseable {
    private final MissClient camera;
    private final PpppConnection connection;
    private final byte[] key;
    private int sequence;
    private boolean active, closed;

    Talkback(MissClient camera, PpppConnection connection, byte[] key) {
        this.camera = camera; this.connection = connection; this.key = Arrays.copyOf(key, key.length);
    }

    synchronized void start() throws IOException {
        if (closed) throw new IOException("talk_closed");
        if (active) return;
        camera.sendEncrypted(0x106, "");
        active = true;
        try { Thread.sleep(1000); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); stop(); throw new IOException("talk_interrupted"); }
    }

    synchronized void pcma(byte[] pcm) throws IOException {
        if (pcm.length != 640) throw new IOException("talk_frame_size");
        byte[] alaw = new byte[320];
        for (int i = 0; i < alaw.length; i++) alaw[i] = AudioCodecs.encodeAlaw((short) ((pcm[i * 2] & 255) | (pcm[i * 2 + 1] << 8)));
        try { send(1027, alaw); } finally { Arrays.fill(alaw, (byte) 0); }
    }

    synchronized void opus(byte[] packet) throws IOException {
        try { AudioCodecs.opusSamples(packet); } catch (IllegalArgumentException invalid) { throw new IOException("talk_opus"); }
        send(1032, packet);
    }

    private void send(int codec, byte[] plain) throws IOException {
        if (!active || closed) throw new IOException("talk_not_started");
        byte[] encrypted = MissCrypto.encrypt(key, plain);
        byte[] message = mediaMessage(codec, System.currentTimeMillis(), encrypted);
        try {
            // Channel 3 is independent of command channel 0. Retransmitted incoming video ACKs do not change it.
            for (int offset = 0; offset < message.length; offset += 1100) {
                int count = Math.min(1100, message.length - offset);
                byte[] payload = new byte[count + 4];
                payload[0] = (byte) 0xD1; payload[1] = 3; payload[2] = (byte) (sequence >>> 8); payload[3] = (byte) sequence;
                sequence = (sequence + 1) & 65535;
                System.arraycopy(message, offset, payload, 4, count);
                try { connection.sendRaw(Frame.encode(Msg.DRW, payload)); }
                finally { Arrays.fill(payload, (byte) 0); }
            }
        } catch (RuntimeException failure) { throw new IOException("talk_send"); }
        finally { Arrays.fill(encrypted, (byte) 0); Arrays.fill(message, (byte) 0); }
    }

    static byte[] mediaMessage(int codec, long timestampMs, byte[] encrypted) {
        if ((codec != 1027 && codec != 1032) || encrypted.length == 0 || encrypted.length > AudioCodecs.MAX_PACKET + 8)
            throw new IllegalArgumentException("talk_packet");
        int length = 32 + encrypted.length;
        ByteBuffer bytes = ByteBuffer.allocate(4 + length).order(ByteOrder.BIG_ENDIAN);
        bytes.putInt(length).order(ByteOrder.LITTLE_ENDIAN);
        bytes.putInt(encrypted.length).putInt(codec).putInt(0).putInt(0).putLong(timestampMs).putLong(0).put(encrypted);
        return bytes.array();
    }

    synchronized void stop() {
        if (!active) return;
        active = false;
        try { camera.sendEncrypted(0x108, ""); } catch (RuntimeException ignored) { }
    }

    @Override public synchronized void close() { stop(); closed = true; Arrays.fill(key, (byte) 0); }
}
