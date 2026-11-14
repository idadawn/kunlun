package cn.idalee.kunlun.staff;

import org.junit.Test;
import static org.junit.Assert.*;

public final class StaffUrlsTest {
    private final StaffUrls urls = new StaffUrls("http://127.0.0.1:5188");

    @Test public void staffPagesAndChunksLoadFromApkWhileApiUsesServer() {
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/staff/orders?q=1"));
        assertEquals("www/static/h5/index-Ab12.js", urls.asset("http://127.0.0.1:5188/static/h5/index-Ab12.js"));
        assertNull(urls.asset("http://127.0.0.1:5188/api/auth/staff/login"));
        assertTrue(urls.api("http://127.0.0.1:5188/api/auth/staff/login"));
        assertFalse(urls.staffPage("http://127.0.0.1:5188/api/members"));
        assertNull(urls.asset("http://127.0.0.1:5188/member"));
        assertNull(urls.asset("http://127.0.0.1:5188/admin"));
    }

    @Test public void rejectsForeignOriginsCredentialsAndAssetTraversal() {
        for (String url : new String[]{"http://127.0.0.1:5175/staff", "http://127.0.0.1.evil/staff", "file:///staff", "javascript:alert(1)", "http://user@127.0.0.1:5188/staff", "http://127.0.0.1:5188/static/h5/%2e%2e/index.html"}) {
            assertNull(urls.asset(url));
            assertFalse(urls.api(url));
        }
    }

    @Test public void httpsUsesTheConfiguredOriginAndStandardPort() {
        StaffUrls release = new StaffUrls("https://kunlun.idalee.cn");
        assertTrue(release.staffPage("https://kunlun.idalee.cn:443/staff"));
        assertFalse(release.api("http://kunlun.idalee.cn/api/auth/me"));
    }
}
