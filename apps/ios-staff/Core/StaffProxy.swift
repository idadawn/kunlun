import Foundation

/// Builds the server request for an API call made by the staff pages and cleans up the reply.
public enum StaffProxy {
    /// Request headers that stay in the app. The API authenticates with the bearer token, the app scheme means
    /// nothing to the server, and URLSession negotiates (and decodes) compression itself.
    static let droppedRequestHeaders: Set<String> = ["cookie", "origin", "referer", "host", "connection", "content-length", "accept-encoding"]
    /// Reply headers that are not handed back: cookies are never used, and URLSession has already decoded the body.
    static let droppedResponseHeaders: Set<String> = ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]

    public static func request(method: String, path: String, query: String?, headers: [String: String], body: Data?,
                               origin: StaffOrigin, timeout: TimeInterval = 30) -> URLRequest? {
        guard let url = StaffRoutes.upstream(path: path, query: query, origin: origin) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        for (name, value) in headers where !droppedRequestHeaders.contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = body
        request.httpShouldHandleCookies = false
        return request
    }

    /// The body of a request from the WebView. WebKit hands it over either as data or as a stream.
    public static func body(of request: URLRequest) -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    public static func responseHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        var kept: [String: String] = [:]
        for (key, value) in headers {
            guard let name = key as? String, !droppedResponseHeaders.contains(name.lowercased()) else { continue }
            kept[name] = "\(value)"
        }
        return kept
    }

    public static func mimeType(forAsset path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json", "map": "application/json; charset=utf-8"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "webp": "image/webp"
        case "ico": "image/x-icon"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        default: "application/octet-stream"
        }
    }
}
