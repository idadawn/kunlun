package cn.idalee.kunlun.staff;

import java.net.URI;
import java.net.URISyntaxException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A newer build announced by the server's {@code /api/app-update/android/staff}, which asks pgyer on the app's behalf.
 * Kept free of Android classes so the JVM tests cover the parsing and the snooze rule.
 */
final class AppUpdate {
    final int versionCode;
    final String versionName;
    final String notes;
    final boolean force;
    final String url;

    AppUpdate(int versionCode, String versionName, String notes, boolean force, String url) {
        this.versionCode = versionCode;
        this.versionName = versionName;
        this.notes = notes;
        this.force = force;
        this.url = url;
    }

    /** The newer build in the server's reply, or null when there is none or the reply cannot be used. */
    static AppUpdate parse(String body, int installed) {
        if (body == null) return null;
        try {
            JSONObject json = new JSONObject(body);
            if (!json.optBoolean("hasUpdate", false)) return null;
            int versionCode = json.optInt("versionCode", 0);
            String url = text(json, "url");
            if (versionCode <= installed || !isInstallPage(url)) return null;
            String name = text(json, "versionName");
            return new AppUpdate(versionCode, name.isEmpty() ? String.valueOf(versionCode) : name, text(json, "notes"),
                json.optBoolean("force", false), url);
        } catch (JSONException e) {
            return null;
        }
    }

    static boolean isNoUpdate(String body) {
        if (body == null) return false;
        try {
            return Boolean.FALSE.equals(new JSONObject(body).opt("hasUpdate"));
        } catch (JSONException e) {
            return false;
        }
    }

    /** Only pgyer's install pages over HTTPS are opened, so a tampered reply cannot send anyone to another download. */
    static boolean isInstallPage(String url) {
        try {
            URI uri = new URI(url);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && uri.getRawUserInfo() == null && uri.getPort() == -1
                && ("www.pgyer.com".equalsIgnoreCase(host) || "pgyer.com".equalsIgnoreCase(host));
        } catch (URISyntaxException e) {
            return false;
        }
    }

    /** A forced update is always shown; otherwise not while the user has put this version off ("以后再说"). */
    static boolean shouldShow(AppUpdate update, int snoozedVersion, long snoozedUntil, long now) {
        return update.force || update.versionCode != snoozedVersion || now >= snoozedUntil;
    }

    // Android's optString turns JSON null into "null".
    private static String text(JSONObject json, String key) {
        return json.isNull(key) ? "" : json.optString(key, "").trim();
    }
}
