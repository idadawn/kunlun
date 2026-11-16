package cn.idalee.kunlun.staff;

import org.junit.Test;
import static org.junit.Assert.*;

public final class StaffUrlsTest {
    private final StaffUrls urls = new StaffUrls("http://127.0.0.1:5188");

    @Test public void staffPagesAndChunksLoadFromApkWhileApiUsesServer() {
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/staff/orders?q=1"));
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/staff/inventory"));
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

    @Test public void phoneLinksYieldOnlyPlausibleNumbers() {
        assertEquals("13800000012", StaffUrls.phoneNumber("tel:13800000012"));
        assertEquals("+86 138 0000 0012", StaffUrls.phoneNumber("tel:+86%20138%200000%200012"));
        assertEquals("0571-8888 6666", StaffUrls.phoneNumber("TEL:0571-8888%206666"));
        for (String url : new String[]{"tel:", "tel:12", "tel:*21%23", "tel:13800000012?body=x", "tel:1380000%0A0012", "sms:13800000012", "http://127.0.0.1:5188/staff", "javascript:alert(1)"}) {
            assertNull(url, StaffUrls.phoneNumber(url));
        }
    }

    @Test public void httpsUsesTheConfiguredOriginAndStandardPort() {
        StaffUrls release = new StaffUrls("https://kunlun.idalee.cn");
        assertTrue(release.staffPage("https://kunlun.idalee.cn:443/staff"));
        assertFalse(release.api("http://kunlun.idalee.cn/api/auth/me"));
    }
}
