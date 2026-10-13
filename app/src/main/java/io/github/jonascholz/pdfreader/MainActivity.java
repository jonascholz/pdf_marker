package io.github.jonascholz.pdfreader;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.DisplayCutout;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.Locale;

/**
 * One full-screen WebView. The viewer (assets/index.html + pdf.js) is served from
 * https://appassets.androidplatform.net/assets/…, the open PDF from …/doc.
 * Markings are stored in SharedPreferences through the "Android" JS bridge.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int PICK_PDF = 1;

    private WebView web;
    private View markLine; // shown in mark mode: pinned to the top edge of the screen, above the page
    private Uri doc;
    private SharedPreferences marks;
    private int[] cutout = {0, 0, 0, 0}; // safe insets in px: top, right, bottom, left

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        marks = getSharedPreferences("marks", MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        web = new WebView(this);
        web.setBackgroundColor(0xFF3A3A3A);
        markLine = new View(this);
        markLine.setBackgroundColor(0xFFF0A060); // a deeper tone of the pastel orange markings
        markLine.setVisibility(View.GONE);
        FrameLayout root = new FrameLayout(this);
        root.addView(web);
        root.addView(markLine, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                Math.round(3 * getResources().getDisplayMetrics().density), Gravity.TOP));
        setContentView(root);
        hideSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebChromeClient(new WebChromeClient()); // enables confirm()/prompt() dialogs
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serve(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return true; // never navigate away from the viewer
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pushInsets();
            }
        });
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 28) {
                DisplayCutout c = insets.getDisplayCutout();
                cutout = c == null ? new int[] {0, 0, 0, 0} : new int[] {
                        c.getSafeInsetTop(), c.getSafeInsetRight(), c.getSafeInsetBottom(), c.getSafeInsetLeft()};
                pushInsets();
            }
            return v.onApplyWindowInsets(insets);
        });

        if (state != null) {
            doc = state.getParcelable("doc");
            if (doc == null) return; // the picker is still open; its result arrives in onActivityResult
        } else {
            doc = getIntent().getData();
        }
        if (doc == null) pickPdf();
        else open();
    }

    private void pickPdf() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/pdf");
        startActivityForResult(pick, PICK_PDF);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_PDF) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            finish();
            return;
        }
        doc = data.getData();
        try {
            // Keeps read access if Android restores this activity after killing the process.
            getContentResolver().takePersistableUriPermission(doc, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
        }
        open();
    }

    private void open() {
        markLine.setVisibility(View.GONE);
        web.loadUrl("https://" + HOST + "/assets/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putParcelable("doc", doc);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Immersive mode: status and navigation bars hidden; a swipe from the edge shows them briefly. */
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    /** Tells the page where a camera cutout is, so no text hides under it. */
    private void pushInsets() {
        float d = getResources().getDisplayMetrics().density;
        web.evaluateJavascript(String.format(Locale.ROOT, "window.setInsets&&setInsets(%.1f,%.1f,%.1f,%.1f)",
                cutout[0] / d, cutout[1] / d, cutout[2] / d, cutout[3] / d), null);
    }

    private WebResourceResponse serve(Uri url) {
        if (!HOST.equals(url.getHost()) || url.getPath() == null) return null;
        String path = url.getPath();
        try {
            if (path.equals("/doc")) {
                InputStream in = doc == null ? null : getContentResolver().openInputStream(doc);
                if (in != null) return new WebResourceResponse("application/pdf", null, in);
            } else if (path.startsWith("/assets/")) {
                String mime = mime(path);
                return new WebResourceResponse(mime, mime.startsWith("text/") ? "utf-8" : null,
                        getAssets().open(path.substring(8)));
            }
        } catch (IOException | SecurityException ignored) {
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }

    /** Markings and reading position per document (keyed by the page: a hash of the PDF bytes); the mark-mode line. */
    private class Bridge {
        @JavascriptInterface
        public String load(String key) {
            return marks.getString(key, "[]");
        }

        @JavascriptInterface
        public void setMarking(boolean on) {
            runOnUiThread(() -> markLine.setVisibility(on ? View.VISIBLE : View.GONE));
        }

        @JavascriptInterface
        public void save(String key, String json) {
            if (json == null || json.equals("[]")) marks.edit().remove(key).apply();
            else marks.edit().putString(key, json).apply();
        }
    }
}
