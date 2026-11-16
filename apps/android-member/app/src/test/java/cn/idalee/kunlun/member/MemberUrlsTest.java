package cn.idalee.kunlun.member;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MemberUrlsTest {
    private final MemberUrls urls = new MemberUrls("http://127.0.0.1:5188");

    @Test public void memberPagesAndChunksLoadFromApkWhileApiUsesServer() {
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/member"));
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/member/records?page=2"));
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/member/assets"));
        // Old links still open the app, whose router forwards them.
        assertEquals("www/index.html", urls.asset("http://127.0.0.1:5188/member/addresses"));
        assertEquals("www/static/h5/MemberApp-Ab12.js", urls.asset("http://127.0.0.1:5188/static/h5/MemberApp-Ab12.js"));
        assertNull(urls.asset("http://127.0.0.1:5188/api/auth/member/login"));
        assertTrue(urls.api("http://127.0.0.1:5188/api/auth/member/login"));
        assertFalse(urls.memberPage("http://127.0.0.1:5188/api/members"));
    }

    @Test public void staffAndAdminPagesNeverOpen() {
        for (String path : new String[]{"/staff", "/staff/orders", "/admin", "/admin/members", "/member/nope", "/member/records/extra", "/", "/index.html"}) {
            assertNull(path, urls.asset("http://127.0.0.1:5188" + path));
            assertFalse(path, urls.memberPage("http://127.0.0.1:5188" + path));
        }
    }

    @Test public void rejectsForeignOriginsCredentialsAndAssetTraversal() {
        for (String url : new String[]{"http://127.0.0.1:5175/member", "http://127.0.0.1.evil/member", "file:///member", "javascript:alert(1)", "tel:13800000000", "http://user@127.0.0.1:5188/member", "http://127.0.0.1:5188/static/h5/%2e%2e/index.html"}) {
            assertNull(url, urls.asset(url));
            assertFalse(url, urls.api(url));
        }
    }

    @Test public void httpsUsesTheConfiguredOriginAndStandardPort() {
        MemberUrls release = new MemberUrls("https://kunlun.idalee.cn");
        assertTrue(release.memberPage("https://kunlun.idalee.cn:443/member/orders"));
        assertTrue(release.api("https://kunlun.idalee.cn/api/auth/me"));
        assertFalse(release.api("http://kunlun.idalee.cn/api/auth/me"));
        assertFalse(release.memberPage("https://kunlun-test.idalee.cn/member"));
    }
}
