package mijia.bridge;

import java.io.OutputStream;
import java.io.PrintStream;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;

/** Test-only harness compiled against our bridge. It never creates a cloud or relay client. */
public final class BridgeProbe {
    public static void main(String[] args) throws Exception {
        PrintStream output = System.out;
        Class.forName("mijia.bridge.Bridge");
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        System.setErr(new PrintStream(OutputStream.nullOutputStream()));
        if (args[0].equals("progress")) {
            Bridge.progress(Bridge.Stage.DEVICE_LOOKUP);
            Bridge.progress(Bridge.Stage.PROVISIONING);
            Bridge.progress(Bridge.Stage.RELAY_CONNECT, 4);
            Bridge.progress(Bridge.Stage.AUTHENTICATION, 4);
            Bridge.progress(Bridge.Stage.WAITING_VIDEO, 4);
            return;
        }
        AtomicLong now = new AtomicLong(0);
        Bridge.VideoWatchdog watchdog = new Bridge.VideoWatchdog(now::get, Duration.ofSeconds(10), Duration.ofSeconds(15));
        try {
            switch (args[0]) {
                case "empty" -> {
                    now.set(Duration.ofSeconds(9).toNanos()); watchdog.observe(false, false);
                    now.set(Duration.ofSeconds(10).toNanos()); watchdog.observe(false, false);
                }
                case "nonkey" -> {
                    for (int seconds = 1; seconds <= 15; seconds++) {
                        now.set(Duration.ofSeconds(seconds).toNanos()); watchdog.observe(true, false);
                    }
                }
                case "latekey" -> {
                    for (int seconds = 1; seconds <= 14; seconds++) {
                        now.set(Duration.ofSeconds(seconds).toNanos()); watchdog.observe(true, false);
                    }
                    now.set(Duration.ofSeconds(15).toNanos()); watchdog.observe(true, true);
                }
                case "afterkey" -> {
                    now.set(Duration.ofSeconds(1).toNanos()); watchdog.observe(true, true);
                    now.set(Duration.ofSeconds(11).toNanos()); watchdog.observe(false, false);
                }
                case "timely" -> {
                    for (int seconds = 1; seconds <= 40; seconds++) {
                        now.set(Duration.ofSeconds(seconds).toNanos()); watchdog.observe(true, seconds % 2 == 0);
                    }
                }
                case "audio" -> {
                    for (int seconds = 1; seconds <= 10; seconds++) {
                        now.set(Duration.ofSeconds(seconds).toNanos()); watchdog.observe(false, true);
                    }
                }
                default -> throw new IllegalArgumentException("invalid_probe");
            }
            output.println("{\"success\":true}");
        } catch (RuntimeException failure) {
            if (!"no_video".equals(failure.getMessage())) throw failure;
            output.println("{\"success\":false,\"reason\":\"no_video\"}");
        }
    }
}
