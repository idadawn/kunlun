package cn.idalee.kunlun.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Credentials belong to one installed app, API origin and login area. Only its bundled top-level page may access them. */
public final class SavedLogin {
    private static final String ALIAS = "kunlun.mobile.login.v1";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private SavedLogin() {}

    public static void install(WebView view, String pageOrigin, String apiOrigin) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        SharedPreferences prefs = view.getContext().getSharedPreferences("saved_login", Context.MODE_PRIVATE);
        WebViewCompat.addWebMessageListener(view, "kunlunSavedLogin", Collections.singleton(pageOrigin),
            (sender, message, source, mainFrame, reply) -> {
                if (!mainFrame || sender.getUrl() == null) return;
                Uri page = Uri.parse(sender.getUrl());
                List<String> parts = page.getPathSegments();
                if (parts.isEmpty() || !("staff".equals(parts.get(0)) || "member".equals(parts.get(0)))) return;
                String area = parts.get(0);
                String scope = apiOrigin + "/" + area;
                if (message.getType() != WebMessageCompat.TYPE_STRING) return;
                String data = message.getData();
                if (data == null || data.length() > 32768) return;
                IO.execute(() -> {
                    JSONObject result = new JSONObject();
                    try {
                        JSONObject request = new JSONObject(data);
                        result.put("id", request.getInt("id"));
                        if (!apiOrigin.equals(request.getString("origin")) || !area.equals(request.getString("area"))) throw new IllegalArgumentException();
                        switch (request.getString("action")) {
                            case "read":
                            case "credentials":
                                String saved = prefs.getString(scope, null);
                                if (saved != null) {
                                    JSONObject stored = decrypt(scope, saved);
                                    if ("read".equals(request.getString("action"))) stored.remove("password");
                                    else if (!stored.getString("accessToken").equals(request.getJSONObject("login").getString("accessToken"))) break;
                                    result.put("login", stored);
                                }
                                break;
                            case "save":
                                JSONObject login = request.getJSONObject("login");
                                if (!prefs.edit().putString(scope, encrypt(scope, login)).commit())
                                    throw new IllegalStateException();
                                break;
                            case "clear":
                                if (!prefs.edit().remove(scope).commit()) throw new IllegalStateException();
                                break;
                            default: throw new IllegalArgumentException();
                        }
                        result.put("ok", true);
                    } catch (Exception ignored) { /* Reply without secrets or exception details. */ }
                    sender.post(() -> reply.postMessage(result.toString()));
                });
            });
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private static String encrypt(String scope, JSONObject login) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
        byte[] sealed = cipher.doFinal(login.toString().getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(sealed, Base64.NO_WRAP);
    }

    private static JSONObject decrypt(String scope, String saved) throws Exception {
        String[] fields = saved.split("\\.", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(fields[0], Base64.NO_WRAP)));
        cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
        byte[] data = cipher.doFinal(Base64.decode(fields[1], Base64.NO_WRAP));
        return new JSONObject(new String(data, StandardCharsets.UTF_8));
    }
}
