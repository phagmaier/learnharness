/**
 * The demo iframe bridge (W6), shared by the chat's demo card
 * (components/artifacts/demo-card.tsx) and conversation exports: injected
 * into every demo, never the model's job. ResizeObserver → postMessage
 * {type:"demo-resize",height} (the parent sizes the iframe) and
 * window.onerror → {type:"demo-error",message}. Moved to core unchanged
 * (plan 03 item 2) so server-built exports embed the same bridge.
 */

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var post=function(){
var b=document.body;
if(!b){send({type:"demo-resize",height:document.documentElement.scrollHeight});return}
var h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);
var cs=getComputedStyle(b);
h+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);
send({type:"demo-resize",height:Math.ceil(h)})
};
if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}
window.addEventListener("resize",post);
window.addEventListener("load",post);
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
setTimeout(post,50);
setTimeout(post,400);
})();</script>`;

/** Inject the bridge before </body> (or at the end of a body-less document). */
export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}

/** The parent's clamp on reported demo heights (px). */
export const DEMO_MIN_HEIGHT = 80;
export const DEMO_MAX_HEIGHT = 2400;
