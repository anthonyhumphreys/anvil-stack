/**
 * Small operator surface for self-hosted deployments. Credentials are entered
 * by the operator and kept in the browser's memory only; no credential is
 * rendered into this document or persisted by the Worker.
 */
export function selfHostAccountPage(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none">
<title>Anvil self-host account</title>
<style>
body{font:16px system-ui,sans-serif;max-width:58rem;margin:3rem auto;padding:0 1rem;color:#25211f;background:#faf8f4}main{display:grid;gap:1.25rem}section{border:1px solid #d9d1c6;border-radius:8px;padding:1rem;background:#fff}h1{font-size:1.8rem}h2{font-size:1.1rem;margin-top:0}label{display:grid;gap:.35rem;margin:.65rem 0;font-size:.9rem}input{font:inherit;padding:.55rem;border:1px solid #aaa;border-radius:5px}button{font:inherit;padding:.55rem .8rem;border:1px solid #555;border-radius:5px;background:#f1ece5;cursor:pointer}pre{white-space:pre-wrap;background:#f4f1ec;padding:.75rem;border-radius:5px;min-height:1.5rem}.muted{color:#655f58;font-size:.9rem}
</style></head><body><main>
<header><h1>Self-host account</h1><p class="muted">Operator tools for a self-hosted Anvil Sync &amp; Mesh backend. Credentials stay in this tab and are sent only to this backend.</p></header>
<section><h2>First device</h2><label>Deployment admin token<input id="admin" type="password" autocomplete="off"></label><label>Account id<input id="account" autocomplete="off" placeholder="my-account"></label><button id="bootstrap">Issue enrollment code</button><pre id="bootstrap-output" aria-live="polite"></pre></section>
<section><h2>Advanced device inspection</h2><p class="muted">Normal device management happens in Anvil Desktop. Use this read-only inspection when operating a backend without the app. The access token is held in this tab only.</p><label>Device access token<input id="access" type="password" autocomplete="off"></label><button id="refresh">List devices</button><div id="devices"></div></section>
<script>
const $=id=>document.getElementById(id); const output=$('bootstrap-output');
async function call(path,token,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify(body)});const p=await r.json().catch(()=>({}));if(!r.ok||p.error)throw new Error(p.error?.code||('HTTP '+r.status));return p}
$('bootstrap').onclick=async()=>{const button=$('bootstrap');button.disabled=true;output.textContent='Issuing…';try{const p=await call('/v1/enrollment-codes',$('admin').value,{accountId:$('account').value.trim()});output.textContent='Enrollment code: '+p.code+' · expires '+new Date(p.expiresAt).toLocaleString();$('admin').value='';$('account').value=''}catch(e){output.textContent='Error: '+e.message}finally{button.disabled=false}};
$('refresh').onclick=async()=>{const button=$('refresh'),box=$('devices');button.disabled=true;box.textContent='Loading…';try{const p=await call('/v1/rpc',$('access').value,{protocol:'anvil-backend/1',requestId:crypto.randomUUID(),operation:'device.list',params:{}});box.innerHTML='';for(const d of p.result.devices||[]){const row=document.createElement('p');row.textContent=(d.revoked?'revoked':'active')+' · '+d.enrollmentId+' · '+(d.displayName||'(unnamed)');box.append(row)}}catch(e){box.textContent='Error: '+e.message}finally{button.disabled=false}};
</script></main></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' } });
}
