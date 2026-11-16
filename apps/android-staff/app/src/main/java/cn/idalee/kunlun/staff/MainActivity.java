package cn.idalee.kunlun.staff;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

public final class MainActivity extends Activity {
    private static final String HOME = BuildConfig.STAFF_ORIGIN + "/staff";
    private final StaffUrls urls = new StaffUrls(BuildConfig.STAFF_ORIGIN);
    private FrameLayout root;
    private WebViewAssetLoader assets;
    private WebView webView;
    private LinearLayout errorView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Member names, phone numbers and addresses stay out of the recent-apps thumbnail.
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        assets = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(248, 250, 252));
        webView = newWebView();
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorView.setBackgroundColor(Color.rgb(248, 250, 252));
        TextView error = new TextView(this);
        error.setText(R.string.page_error);
        error.setTextSize(16);
        errorView.addView(error, new LinearLayout.LayoutParams(-2, -2));
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> { errorView.setVisibility(View.GONE); webView.loadUrl(HOME); });
        LinearLayout.LayoutParams belowError = new LinearLayout.LayoutParams(-2, -2);
        belowError.topMargin = Math.round(16 * getResources().getDisplayMetrics().density);
        errorView.addView(retry, belowError);
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets padding = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::navigateBack);
        }
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(HOME);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView newWebView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                String asset = urls.asset(url);
                if (asset != null && "GET".equals(request.getMethod())) {
                    // Resolve packaged files with AssetLoader; the document retains the configured API origin.
                    return assets.shouldInterceptRequest(Uri.parse("https://appassets.androidplatform.net/assets/" + asset));
                }
                if (urls.api(url)) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
                    new ByteArrayInputStream("Only staff application content is allowed".getBytes(StandardCharsets.UTF_8)));
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (urls.staffPage(url)) return false;
                // As on iOS, tapping a phone number (such as a delivery contact) opens the dialer with it filled in;
                // placing the call is still up to the staff member.
                String number = StaffUrls.phoneNumber(url);
                if (number != null && request.hasGesture()) dial(number);
                return true;
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) errorView.setVisibility(View.VISIBLE);
            }

            @Override public boolean onRenderProcessGone(WebView gone, RenderProcessGoneDetail detail) {
                // The system may end the page's renderer, e.g. to free memory. Replace the dead WebView instead of
                // letting the app crash; its login goes with it. After a crash the retry screen waits for a tap, so a
                // page that keeps crashing cannot loop.
                root.removeView(gone);
                gone.destroy();
                webView = newWebView();
                root.addView(webView, 0, new FrameLayout.LayoutParams(-1, -1));
                if (detail.didCrash()) errorView.setVisibility(View.VISIBLE); else webView.loadUrl(HOME);
                return true;
            }
        });
        return view;
    }

    private void dial(String number) {
        try {
            startActivity(new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)));
        } catch (ActivityNotFoundException e) {
            // No phone app, as on some tablets: the number stays visible on the page.
        }
    }

    private void navigateBack() { if (webView.canGoBack()) webView.goBack(); else finish(); }

    // API 33+ uses OnBackInvokedDispatcher above; retain this callback only for Android 8–12.
    @Override @SuppressLint("GestureBackNavigation") @SuppressWarnings("deprecation")
    public void onBackPressed() { navigateBack(); }
    @Override protected void onSaveInstanceState(Bundle state) { webView.saveState(state); super.onSaveInstanceState(state); }
    @Override protected void onPause() { webView.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); webView.onResume(); }
    @Override protected void onDestroy() { webView.destroy(); super.onDestroy(); }
}
