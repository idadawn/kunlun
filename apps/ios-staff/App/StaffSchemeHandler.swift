import Foundation
import WebKit
import os
import KunlunStaffCore

/// Answers every `kunlun-staff://localhost` request: staff pages and build files from the app bundle, `/api/…` calls
/// forwarded to the server, anything else refused.
@MainActor final class StaffSchemeHandler: NSObject, WKURLSchemeHandler {
    private let origin: StaffOrigin
    private let resources: URL
    private let session: URLSession
    /// Calls still waiting for the server. WebKit may stop a call at any time, after which it must not be answered.
    private var calls: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(origin: StaffOrigin, resources: URL = Bundle.main.bundleURL) {
        self.origin = origin
        self.resources = resources
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        session = URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let request = task.request
        let method = request.httpMethod ?? "GET"
        switch request.url.flatMap(StaffRoutes.resource(for:)) {
        case .page: serve("www/index.html", method: method, to: task)
        case .asset(let path): serve(path, method: method, to: task)
        case .api(let path, let query): forward(task, method: method, path: path, query: query)
        case nil: reply(task, status: 403, type: "text/plain; charset=utf-8", body: Data("Only staff application content is allowed".utf8))
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        calls.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }

    private func serve(_ path: String, method: String, to task: any WKURLSchemeTask) {
        guard method == "GET" || method == "HEAD" else {
            return reply(task, status: 405, type: "text/plain; charset=utf-8", body: Data())
        }
        guard let data = try? Data(contentsOf: resources.appending(path: path, directoryHint: .notDirectory)) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        reply(task, status: 200, type: StaffProxy.mimeType(forAsset: path), body: method == "HEAD" ? Data() : data)
    }

    private func forward(_ task: any WKURLSchemeTask, method: String, path: String, query: String?) {
        let request = task.request
        guard let pageURL = request.url,
              let upstream = StaffProxy.request(method: method, path: path, query: query, headers: request.allHTTPHeaderFields ?? [:],
                                                body: StaffProxy.body(of: request), origin: origin) else {
            return reply(task, status: 400, type: "text/plain; charset=utf-8", body: Data())
        }
        let key = ObjectIdentifier(task)
        let started = Date()
        calls[key] = Task { [session] in
            let result: Result<(Data, URLResponse), any Error>
            do { result = .success(try await session.data(for: upstream)) } catch { result = .failure(error) }
            // Stopped by WebKit while waiting: answering now would raise an exception.
            guard calls.removeValue(forKey: key) != nil else { return }
            switch result {
            case .success(let (data, response)):
                let server = response as? HTTPURLResponse
                let status = server?.statusCode ?? 502
                Self.trace(method, path, "\(status)", started)
                let headers = StaffProxy.responseHeaders(server?.allHeaderFields ?? [:])
                task.didReceive(HTTPURLResponse(url: pageURL, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
                task.didReceive(data)
                task.didFinish()
            case .failure(let error):
                Self.trace(method, path, error.localizedDescription, started)
                task.didFailWithError(error)
            }
        }
    }

    private func reply(_ task: any WKURLSchemeTask, status: Int, type: String, body: Data) {
        let url = task.request.url ?? StaffRoutes.start
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": type, "Cache-Control": "no-cache"])!)
        task.didReceive(body)
        task.didFinish()
    }

    /// Debug builds log each API call (method, path and outcome; never queries, headers or bodies).
    private static func trace(_ method: String, _ path: String, _ outcome: String, _ started: Date) {
        #if DEBUG
        let milliseconds = Int(Date().timeIntervalSince(started) * 1000)
        Logger(subsystem: "cn.idalee.kunlun.staff", category: "api")
            .info("\(method, privacy: .public) \(path, privacy: .public) → \(outcome, privacy: .public) \(milliseconds)ms")
        #endif
    }
}

/// Redirects come back to the page as they are, so a call never ends up at another server.
private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}
