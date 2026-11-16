import SwiftUI
import UIKit
import WebKit
import os
import KunlunStaffCore

/// Shows the staff pages bundled with the app. Only staff pages can be opened; `tel:` links go to the phone app.
struct StaffWebView: UIViewRepresentable {
    let origin: StaffOrigin
    /// Raised by the retry button to load the first page again.
    let attempt: Int
    @Binding var failed: Bool

    func makeCoordinator() -> Coordinator { Coordinator(failed: $failed) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(StaffSchemeHandler(origin: origin), forURLScheme: StaffRoutes.scheme)
        let scripts = configuration.userContentController
        // The pages are laid out for phones: no pinch zoom, and no zoom when a small input gets focus.
        scripts.addUserScript(WKUserScript(source: Self.fixedViewport, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        #if DEBUG
        scripts.addUserScript(WKUserScript(source: Self.consoleBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.add(context.coordinator, name: "staffLog")
        #endif

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(StaffPalette.background)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
        context.coordinator.attempt = attempt
        webView.load(URLRequest(url: StaffRoutes.start))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.attempt != attempt else { return }
        context.coordinator.attempt = attempt
        webView.load(URLRequest(url: StaffRoutes.start))
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var attempt = 0
        private let failed: Binding<Bool>

        init(failed: Binding<Bool>) { self.failed = failed }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if StaffRoutes.allowsNavigation(to: url) { return decisionHandler(.allow) }
            if url.scheme?.lowercased() == "tel", action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
            report(error)
        }

        /// iOS may end the page's process in the background; load the page again instead of staying blank.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if webView.url == nil { webView.load(URLRequest(url: StaffRoutes.start)) } else { webView.reload() }
        }

        private func report(_ error: any Error) {
            let error = error as NSError
            // A load replaced by another one, or one the navigation policy interrupted ("frame load interrupted"),
            // is not a failure.
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
            if error.domain == "WebKitErrorDomain" && error.code == 102 { return }
            failed.wrappedValue = true
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            #if DEBUG
            if let text = message.body as? String { Self.webLog.info("\(text, privacy: .public)") }
            #endif
        }

        #if DEBUG
        static let webLog = Logger(subsystem: "cn.idalee.kunlun.staff", category: "web")
        #endif
    }

    private static let fixedViewport = """
    (function () {
      var meta = document.querySelector('meta[name=viewport]');
      if (meta) meta.setAttribute('content', 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no');
    })();
    """

    #if DEBUG
    /// Debug builds copy page errors and warnings to the system log (subsystem `cn.idalee.kunlun.staff`).
    private static let consoleBridge = """
    (function () {
      function post(level, items) {
        try {
          var text = Array.prototype.map.call(items, function (item) {
            if (item instanceof Error) return item.stack || item.message;
            if (typeof item === 'string') return item;
            try { return JSON.stringify(item); } catch (e) { return String(item); }
          }).join(' ');
          window.webkit.messageHandlers.staffLog.postMessage(level + ' ' + text);
        } catch (e) {}
      }
      ['error', 'warn'].forEach(function (level) {
        var original = console[level];
        console[level] = function () { post(level, arguments); return original.apply(console, arguments); };
      });
      addEventListener('error', function (event) { post('error', [event.message + ' @ ' + event.filename + ':' + event.lineno]); });
      addEventListener('unhandledrejection', function (event) { post('error', ['unhandled rejection', event.reason]); });
      post('info', ['page ' + location.href + ' secureContext=' + window.isSecureContext]);
    })();
    """
    #endif
}
