package cn.idalee.kunlun.staff;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AppUpdateTest {
    private static final String NEWER = "{\"hasUpdate\":true,\"versionName\":\"1.2.0\",\"versionCode\":3,"
        + "\"notes\":\"新增自动更新\\n修正若干问题\",\"force\":false,\"url\":\"https://www.pgyer.com/Lvq1\"}";

    @Test public void readsANewerBuild() {
        AppUpdate update = AppUpdate.parse(NEWER, 2);
        assertNotNull(update);
        assertEquals(3, update.versionCode);
        assertEquals("1.2.0", update.versionName);
        assertEquals("新增自动更新\n修正若干问题", update.notes);
        assertFalse(update.force);
        assertEquals("https://www.pgyer.com/Lvq1", update.url);
    }

    @Test public void readsAForcedUpdateWithoutNameOrNotes() {
        AppUpdate update = AppUpdate.parse("{\"hasUpdate\":true,\"versionName\":null,\"versionCode\":3,\"notes\":null,"
            + "\"force\":true,\"url\":\"https://pgyer.com/Lvq1\"}", 2);
        assertNotNull(update);
        assertTrue(update.force);
        assertEquals("3", update.versionName);
        assertEquals("", update.notes);
    }

    @Test public void offersNothingWithoutANewerBuild() {
        assertNull(AppUpdate.parse("{\"hasUpdate\":false,\"versionName\":null,\"versionCode\":null,\"notes\":null,\"force\":false,\"url\":null}", 2));
        assertNull(AppUpdate.parse(NEWER, 3));
        assertNull(AppUpdate.parse(NEWER, 4));
        assertNull(AppUpdate.parse(NEWER.replace("\"versionCode\":3,", ""), 2));
        assertNull(AppUpdate.parse("<html>", 2));
        assertNull(AppUpdate.parse("", 2));
        assertNull(AppUpdate.parse(null, 2));
    }

    @Test public void opensOnlyPgyerInstallPagesOverHttps() {
        assertTrue(AppUpdate.isInstallPage("https://www.pgyer.com/Lvq1"));
        assertTrue(AppUpdate.isInstallPage("https://pgyer.com/Lvq1"));
        for (String url : new String[] {
            "http://www.pgyer.com/Lvq1", "https://www.pgyer.com.evil.example/Lvq1", "https://www.pgyer.com@evil.example/Lvq1",
            "https://evil.example/www.pgyer.com", "https://www.pgyer.com:8443/Lvq1", "intent://www.pgyer.com/Lvq1",
            "javascript:alert(1)", "www.pgyer.com/Lvq1", "", "https://www.pgyer.com/ Lvq1",
        }) {
            assertFalse(url, AppUpdate.isInstallPage(url));
            assertNull(url, AppUpdate.parse(NEWER.replace("https://www.pgyer.com/Lvq1", url), 2));
        }
    }

    @Test public void laterHidesThatVersionForADayButNeverAForcedUpdate() {
        AppUpdate update = AppUpdate.parse(NEWER, 2);
        long now = 1_000_000L;
        assertTrue(AppUpdate.shouldShow(update, 0, 0, now));
        assertFalse(AppUpdate.shouldShow(update, 3, now + 1, now));
        assertTrue(AppUpdate.shouldShow(update, 3, now, now));
        assertTrue(AppUpdate.shouldShow(update, 2, now + 1, now));
        AppUpdate forced = new AppUpdate(3, "1.2.0", "", true, update.url);
        assertTrue(AppUpdate.shouldShow(forced, 3, now + 1, now));
    }
}
