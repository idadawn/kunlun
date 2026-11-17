package cn.idalee.kunlun.member;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Asks the server whether pgyer has a newer build: when the app starts, then at most hourly as it comes back to the
 * foreground. A newer build opens a dialog whose "立即更新" opens pgyer's install page in the browser; "以后再说"
 * hides that version for a day. A forced update has no "以后再说" and comes back each time the app is resumed.
 */
final class UpdateChecker {
    private static final String ENDPOINT = BuildConfig.MEMBER_ORIGIN + "/api/app-update/android/member?versionCode=" + BuildConfig.VERSION_CODE;
    private static final long CHECK_EVERY_MS = 60 * 60 * 1000L, RETRY_MS = 5 * 60 * 1000L, SNOOZE_MS = 24 * 60 * 60 * 1000L;
    private static final int MAX_REPLY_BYTES = 64 * 1024;
    // Per process, so a re-created activity neither checks again at once nor forgets a forced update.
    private static long nextCheck = Long.MIN_VALUE;
    private static AppUpdate forced;

    private final Activity activity;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private AlertDialog dialog;

    UpdateChecker(Activity activity) {
        this.activity = activity;
        prefs = activity.getSharedPreferences("app_update", Context.MODE_PRIVATE);
    }

    void onResume() {
        if (forced != null) { show(forced); return; }
        long now = SystemClock.elapsedRealtime();
        if (now < nextCheck) return;
        nextCheck = now + CHECK_EVERY_MS;
        new Thread(() -> {
            String reply = fetch();
            main.post(() -> {
                // Offline or the server is away: try again on a later resume, not only after an hour.
                if (reply == null) { nextCheck = SystemClock.elapsedRealtime() + RETRY_MS; return; }
                AppUpdate update = AppUpdate.parse(reply, BuildConfig.VERSION_CODE);
                if (update != null) offer(update);
            });
        }, "update-check").start();
    }

    void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (dialog != null) dialog.dismiss();
    }

    private void offer(AppUpdate update) {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        if (update.force) forced = update;
        if (AppUpdate.shouldShow(update, prefs.getInt("snoozedVersion", 0), prefs.getLong("snoozedUntil", 0), System.currentTimeMillis())) show(update);
    }

    private void show(AppUpdate update) {
        if (dialog != null && dialog.isShowing()) return;
        StringBuilder message = new StringBuilder(update.notes.isEmpty() ? activity.getString(R.string.update_notes_default) : update.notes)
            .append("\n\n").append(activity.getString(R.string.update_current, BuildConfig.VERSION_NAME));
        if (update.force) message.append('\n').append(activity.getString(R.string.update_required));
        AlertDialog.Builder builder = new AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.update_title, update.versionName))
            .setMessage(message)
            .setCancelable(!update.force)
            .setPositiveButton(R.string.update_now, (d, which) -> open(update.url));
        if (!update.force) {
            // Back counts as "以后再说"; a stray tap outside the dialog does not.
            builder.setNegativeButton(R.string.update_later, (d, which) -> snooze(update))
                .setOnCancelListener(d -> snooze(update));
        }
        dialog = builder.create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.show();
    }

    private void snooze(AppUpdate update) {
        prefs.edit().putInt("snoozedVersion", update.versionCode).putLong("snoozedUntil", System.currentTimeMillis() + SNOOZE_MS).apply();
    }

    private void open(String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.update_no_browser, Toast.LENGTH_LONG).show();
        }
    }

    /** The server's reply, or null when it could not be reached or did not answer 200. */
    private static String fetch() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                for (int n; (n = in.read(buffer)) != -1; ) {
                    body.write(buffer, 0, n);
                    if (body.size() > MAX_REPLY_BYTES) return null;
                }
                return new String(body.toByteArray(), StandardCharsets.UTF_8);
            }
        } catch (IOException | RuntimeException e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
