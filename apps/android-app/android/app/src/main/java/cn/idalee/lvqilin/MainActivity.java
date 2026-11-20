package cn.idalee.lvqilin;

import cn.idalee.kunlun.mobile.SavedLogin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override protected void load() {
        SavedLogin.install(findViewById(com.getcapacitor.android.R.id.webview), "https://localhost", BuildConfig.API_ORIGIN);
        super.load();
    }
}
