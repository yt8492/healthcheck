@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)

package healthcheck

import kotlinx.serialization.json.Json
import kotlin.js.JsAny

@JsFun("() => JSON.stringify(Object.fromEntries(new URLSearchParams(location.search)))")
private external fun queryJson(): String

@JsFun("""(from, to, resolution, metric, replace) => {
    const url = new URL(location.href);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('resolution', resolution);
    url.searchParams.set('activityMetric', metric);
    for (const key of ['sleepFrom', 'sleepTo', 'activityFrom', 'activityTo']) url.searchParams.delete(key);
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
}""")
private external fun writeUrl(from: String, to: String, resolution: String, metric: String, replace: Boolean)

@JsFun("(callback) => { window.addEventListener('popstate', callback); return callback; }")
private external fun subscribeHistory(callback: () -> Unit): JsAny

@JsFun("(callback) => window.removeEventListener('popstate', callback)")
private external fun unsubscribeHistory(callback: JsAny)

@JsFun("(path) => window.location.assign(path)")
private external fun navigateTo(path: String)

@JsFun("() => window.location.origin")
external fun browserOrigin(): String

@JsFun("() => { document.getElementById('boot').hidden = true; }")
external fun hideBootScreen()

@JsFun("""() => {
    const boot = document.getElementById('boot');
    boot.textContent = '文字の表示に必要なデータを読み込めませんでした。';
    const retry = document.createElement('button');
    retry.textContent = '再読み込み';
    retry.onclick = () => location.reload();
    boot.appendChild(retry);
}""")
external fun showFontLoadError()

object WebNavigation : BrowserNavigation {
    override fun readQuery(): Map<String, String> = Json.decodeFromString(queryJson())
    override fun writeSelection(selection: Selection, replace: Boolean) = with(selection) {
        writeUrl(range.from, range.to, resolution, metric, replace)
    }
    override fun observeHistory(onChange: () -> Unit): () -> Unit {
        val subscription = subscribeHistory(onChange)
        return { unsubscribeHistory(subscription) }
    }
    override fun navigate(path: String) = navigateTo(path)
}
