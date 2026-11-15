package cn.idalee.kunlun.staff;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Local assets share the API origin; only staff routes and the configured server are allowed. */
final class StaffUrls {
    private static final Set<String> PAGES = new HashSet<>(Arrays.asList("/staff", "/staff/home", "/staff/order", "/staff/orders", "/staff/members", "/staff/profile"));
    private final URI origin;

    StaffUrls(String origin) { this.origin = URI.create(origin); }

    boolean sameOrigin(String value) {
        try {
            URI uri = URI.create(value);
            return uri.getUserInfo() == null && origin.getScheme().equalsIgnoreCase(uri.getScheme())
                && origin.getHost().equalsIgnoreCase(uri.getHost()) && port(origin) == port(uri);
        } catch (IllegalArgumentException e) { return false; }
    }

    private static int port(URI uri) { return uri.getPort() == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : uri.getPort(); }

    String asset(String value) {
        if (!sameOrigin(value)) return null;
        String path = URI.create(value).getPath();
        if (PAGES.contains(path)) return "www/index.html";
        if (path != null && path.startsWith("/static/h5/") && path.matches("[a-zA-Z0-9_./-]+")
            && !path.contains("..") && !path.contains("//")) return "www" + path;
        return null;
    }

    boolean staffPage(String value) { return "www/index.html".equals(asset(value)); }

    boolean api(String value) {
        if (!sameOrigin(value)) return false;
        String path = URI.create(value).getPath();
        return path != null && path.startsWith("/api/") && !path.contains("..") && !path.contains("//");
    }
}
