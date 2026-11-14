var V={"example-bundle":"Example dataset","fsa-folder":"Local folder","fsa-file":"Local file",http:"Public URL","s3-endpoint":"S3 bucket","iceberg-table":"Iceberg table","iceberg-catalog":"Iceberg catalog","compute-bridge":"Compute bridge","compute-bridge-catalog":"Compute bridge"};function z(t){try{return new URL(t).host||null}catch{return null}}function D(t){switch(t.kind){case"http":return t.ref??null;case"s3-endpoint":return t.s3?`s3://${t.s3.bucket}/${t.s3.pathPrefix??""}`:null;case"iceberg-table":return t.iceberg?.metadataUrl??null;case"iceberg-catalog":return t.icebergCatalog?`${t.icebergCatalog.catalogUrl} \xB7 ${t.icebergCatalog.namespace}.${t.icebergCatalog.table}`:null;case"compute-bridge":return t.bridge?.bridgeUrl??null;case"compute-bridge-catalog":return t.bridgeCatalog?.bridgeUrl??null;default:return null}}function q(t){let h=D(t),x=t.http?[t.http.ingestionMode==="materialized"?"materialized once":"remote reader",t.http.encoding==="windows-1252"?"Windows-1252":t.http.encoding].filter(Boolean).join(" \xB7 "):null;return{label:t.label,kindLabel:V[t.kind]??t.kind,location:h,host:h?z(h):null,ingestion:x,tables:t.tables.map(u=>({name:u.name,format:u.format,rowCount:u.rowCount}))}}var M={bg:"#FAF8F3",surface:"#FFFFFF",surfaceSubtle:"#F9FAFB",surfaceCool:"#F3F4F6",surfaceMap:"#FAF7F0",surfaceAlt:"#F1ECE3",border:"#989083",borderStrong:"#7D7569",borderCool:"#D1D5DB",borderLight:"#E5E7EB",borderMuted:"#CCCCCC",text:"#1F1B16",textStrong:"#111111",textCool:"#374151",textSecondary:"#666666",textMuted:"#6B6358",textCoolMuted:"#6B7280",textFaint:"#999999",placeholder:"#9CA3AF",onStrong:"#FFFFFF",accent:"#B5371C",accentHover:"#963115",accentSoft:"#E9C1B5",actionWarm:"#FFB066",focus:"#436A8A",danger:"#A8453F",success:"#2F6E5A",warning:"#D58A3C"},B={dangerSoft:"#FDECE3",dangerBg:"#F6D6D3",piiBg:"#FEE2E2",piiText:"#991B1B",financialBg:"#FEF3C7",warningBg:"#FFFBEB",warningText:"#92400E",warningAccent:"#F59E0B",infoBg:"#EFF6FF",infoText:"#1E40AF",infoAccent:"#3B82F6",publicBg:"#E0E7FF",successBg:"#F0FDF4",successText:"#166534",successAccent:"#16A34A",secretBg:"#FCE7F3",secretText:"#9D174D"};function Z(t){return I(t)}function I(t){let h=v=>v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),x=v=>h(v).replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/\*([^*]+)\*/g,"<em>$1</em>"),u=t.split(/\r?\n/),m=[],f=null,p=[],r=()=>{p.length!==0&&(m.push(`<p>${x(p.join(" "))}</p>`),p=[])},i=()=>{f&&(m.push(`</${f}>`),f=null)};for(let v of u){let c=v.trimEnd(),k=/^(#{1,6})\s+(.*)$/.exec(c);if(k){r(),i();let T=k[1]?.length??1;m.push(`<h${T}>${x(k[2]??"")}</h${T}>`);continue}let C=/^[-*]\s+(.*)$/.exec(c);if(C){r(),f!=="ul"&&(i(),m.push("<ul>"),f="ul"),m.push(`<li>${x(C[1]??"")}</li>`);continue}let y=/^\d+\.\s+(.*)$/.exec(c);if(y){r(),f!=="ol"&&(i(),m.push("<ol>"),f="ol"),m.push(`<li>${x(y[1]??"")}</li>`);continue}if(c===""){r(),i();continue}i(),p.push(c)}return r(),i(),m.join(`
`)}function R(t){return!t||t.length===0?"":`<section class="provenance"><h2>Sources</h2><ul class="src-list">${t.map(x=>{let u=q(x),m=u.location?` \u2014 <code>${l(u.location)}</code>`:"",f=u.tables.map(p=>`<li>${l(p.name)} \xB7 ${l(p.format)} \xB7 ${p.rowCount.toLocaleString()} rows</li>`).join("");return`<li><strong>${l(u.label)}</strong> <span class="src-kind">${l(u.kindLabel)}</span>${m}<ul>${f}</ul></li>`}).join("")}</ul></section>`}function j(t){let h=(t.title?.trim()||"NakliData notebook").slice(0,200),x=t.exportedAt??new Date().toISOString(),u=t.notebookRoot.querySelector(".notebook")??t.notebookRoot,m=Array.from(u.children).filter(o=>o instanceof HTMLElement&&o.classList.contains("cell")),f=[],p=[],r=(o,e,a,s="rendered",E=null)=>{f.push(a),p.push({kind:o,name:e,status:s,reason:E})},i=(o,e)=>`<div class="placeholder-note" role="note">${o}<strong>Static placeholder:</strong> ${l(e)}</div>`;for(let o of m){let e=o.dataset.cellKind??"unknown",a=o.querySelector('[data-region="cell-name"], [data-action="cell-name-edit"]')?.value?.trim()||"",s=a?`<h3 class="cell-name">${l(a)}</h3>`:"";if(e==="markdown"){let n=o.querySelector(".markdown-preview"),d=o.querySelector("textarea"),g=n?.innerHTML??Z(d?.value??"");r(e,a,`<section class="cell md" data-export-kind="${e}">${s}<div class="md-body">${g}</div></section>`);continue}if(e==="chart"){let n=o.querySelector("svg, table");n?r(e,a,`<section class="cell chart" data-export-kind="${e}">${s}${n.outerHTML}</section>`):r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,"Chart was not rendered before export.")}</section>`,"placeholder","Chart was not rendered before export.");continue}if(e==="pivot"){let n=o.querySelector(".pivot-table, table");n?r(e,a,`<section class="cell pivot" data-export-kind="${e}">${s}${n.outerHTML}</section>`):r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,"Pivot result was not rendered before export.")}</section>`,"placeholder","Pivot result was not rendered before export.");continue}if(e==="map"||e==="embedding"||e==="network"){let n=`${e[0]?.toUpperCase()}${e.slice(1)} uses an interactive WebGL canvas that cannot be serialized safely.`;r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,n)}</section>`,"placeholder",n);continue}if(e==="dashboard"){let n=o.querySelector(".dashboard-grid"),d=n?window.getComputedStyle(n).gridTemplateColumns.split(" ").length:2,g=n?Array.from(n.querySelectorAll(".dashboard-slot")):[],b=[],w=0;for(let $ of g){let H=$.querySelector("svg"),L=$.querySelector(".markdown-preview"),A=$.querySelector("table");if(L)b.push(`<div class="dashboard-slot">${L.outerHTML}</div>`);else if(H)b.push(`<div class="dashboard-slot">${H.outerHTML}</div>`);else if(A)b.push(`<div class="dashboard-slot">${A.outerHTML}</div>`);else{w++;let F=$.textContent?.trim()??"";b.push(`<div class="dashboard-slot empty">${i("",F||"Dashboard slot was unavailable.")}</div>`)}}let S=g.length===0?"Dashboard had no serializable slots.":w>0?`${w} of ${g.length} dashboard slots were unavailable.`:null;r(e,a,`<section class="cell dashboard${S?" placeholder":""}" data-export-kind="${e}">${s}<div class="dashboard-grid" style="display:grid;grid-template-columns:repeat(${d},1fr);gap:12px;">${b.join("")}</div></section>`,S?"placeholder":"rendered",S);continue}if(e==="input"){let n=o.querySelector('[data-region="input-widget"] input, [data-region="input-widget"] select'),d=o.querySelector(".cell-input-body label")?.textContent?.trim()??"",g=n?.value??"";r(e,a,`<section class="cell input-note" data-export-kind="${e}">${s}<div class="note"><strong>${l(d)}</strong> ${l(g)}</div></section>`);continue}if(e==="sql"||e==="cohort"||e==="assertion"){let n=o.querySelector(".cm-content"),d=o.querySelector("textarea"),g=n?.textContent??d?.value??"",b=o.querySelector(".result-table"),w=o.querySelector(".cell-result-meta"),S=[];if(w)for(let A of w.querySelectorAll("span")){let F=A.textContent?.trim();F&&S.push(F)}let $=S.join(" \xB7 "),H=`${e.toUpperCase()}${a?` \xB7 ${l(a)}`:""}${$?` \xB7 ${l($)}`:""}`,L=[g?`<pre class="sql"><code>${l(g)}</code></pre>`:"",b?b.outerHTML:""].join(`
`);r(e,a,`<section class="cell sql" data-export-kind="${e}"><details><summary>${l(H)}</summary>${L}</details></section>`);continue}if(e==="report"){let n=o.querySelector(".report-paper");n?r(e,a,`<section class="cell report" data-export-kind="${e}">${s}${n.outerHTML}</section>`):r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,"Report layout was unavailable.")}</section>`,"placeholder","Report layout was unavailable.");continue}if(e==="stats"){let n=o.querySelector(".cell-output"),d=n?.querySelector("table");n&&d?r(e,a,`<section class="cell stats" data-export-kind="${e}">${s}${n.outerHTML}</section>`):r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,"Statistics were not computed before export.")}</section>`,"placeholder","Statistics were not computed before export.");continue}if(e==="python"||e==="r"){let n=o.querySelector(".cm-content")?.textContent??o.querySelector("textarea")?.value??"",d=o.querySelector(".cell-output .result-table"),g=n?`<pre class="sql"><code>${l(n)}</code></pre>`:"";if(d)r(e,a,`<section class="cell language" data-export-kind="${e}">${s}${g}${d.outerHTML}</section>`);else{let b=`${e==="python"?"Python":"R"} result was not available before export.`;r(e,a,`<section class="cell language placeholder" data-export-kind="${e}">${s}${g}${i("",b)}</section>`,"placeholder",b)}continue}if(e==="temporal"||e==="distribution"){let n=o.querySelector(".cell-output svg");if(n)r(e,a,`<section class="cell chart" data-export-kind="${e}">${s}${n.outerHTML}</section>`);else{let d=`${e==="temporal"?"Timeline":"Distribution"} was not rendered before export.`;r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,d)}</section>`,"placeholder",d)}continue}let E=`Cell kind "${e}" has no static renderer.`;r(e,a,`<section class="cell placeholder" data-export-kind="${e}">${i(s,E)}</section>`,"placeholder",E)}let v=p.filter(o=>o.status==="rendered").length,c={totalCells:m.length,includedCells:p.length,renderedCells:v,omittedCells:p.length-v,cells:p},k=c.totalCells===0?"Empty notebook":`${c.totalCells} cells \xB7 ${c.renderedCells} rendered \xB7 ${c.omittedCells} placeholders`,C=c.cells.map((o,e)=>`<li><strong>${l(o.name||`${o.kind} ${e+1}`)}</strong> \xB7 ${l(o.kind)} \xB7 ${o.status}${o.reason?` \u2014 ${l(o.reason)}`:""}</li>`).join(""),y=`<section class="export-manifest"><details open><summary>Export manifest \u2014 ${c.renderedCells} rendered, ${c.omittedCells} placeholders</summary><p>All ${c.includedCells} of ${c.totalCells} notebook cells are represented below.</p><ol>${C}</ol></details></section>`;return{html:`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${l(h)}</title>
<style>
:root{--ink:${M.textStrong};--muted:${M.textCoolMuted};--surface:${M.surfaceSubtle};--border:${M.borderLight};--accent:${M.accent};--paper:${M.surface};--manifest:${B.warningBg}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:48px 24px;background:var(--paper);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:880px;margin:0 auto}
header{margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}
header h1{margin:0 0 4px;font-size:24px;font-weight:600}
header .meta{color:var(--muted);font-size:13px}
.cell{margin:24px 0}
.cell.md h1,.cell.md h2,.cell.md h3{margin-top:24px;margin-bottom:8px;font-weight:600}
.cell.md h1{font-size:22px}
.cell.md h2{font-size:18px}
.cell.md h3{font-size:16px}
.cell.md p{margin:8px 0}
.cell.md code{background:var(--surface);padding:1px 4px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
.cell.md pre{background:var(--surface);padding:12px;border-radius:6px;overflow:auto;font-size:13px}
.cell.md ul,.cell.md ol{margin:8px 0;padding-left:24px}
.cell .cell-name{margin:0 0 8px;font-size:13px;color:var(--muted);font-weight:500;letter-spacing:.02em;text-transform:uppercase}
.cell.chart svg{max-width:100%;height:auto;display:block}
.cell.placeholder{padding:16px;background:var(--surface);border:1px dashed var(--border);border-radius:6px}
.placeholder-note{color:var(--muted);font-size:13px}
.placeholder-note strong{color:var(--ink)}
.cell .note{color:var(--muted);font-style:italic;font-size:13px}
.cell table{width:100%;border-collapse:collapse;font-size:13px;background:var(--paper)}
.cell th,.cell td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
.cell th{background:var(--surface);font-weight:600}
.cell td.numeric{text-align:right;font-variant-numeric:tabular-nums}
.cell.sql details{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:0 12px}
.cell.sql summary{cursor:pointer;padding:10px 0;font-size:13px;color:var(--muted);font-weight:500}
.cell.sql summary::-webkit-details-marker{color:var(--muted)}
.cell pre.sql{background:var(--paper);border:1px solid var(--border);border-radius:4px;padding:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;overflow:auto;margin:8px 0}
.cell.sql .result-table{margin:8px 0 12px;font-size:12.5px}
.cell.report .report-paper{box-shadow:none!important;max-width:none!important;margin:0!important}
.export-manifest{margin:0 0 32px;padding:12px 16px;background:var(--manifest);border:1px solid var(--border);border-radius:6px;font-size:13px}
.export-manifest summary{font-weight:600;cursor:pointer}
.export-manifest p{margin:8px 0;color:var(--muted)}
.export-manifest ol{margin:8px 0;padding-left:22px}
.export-manifest li{margin:3px 0}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);color:var(--muted);font-size:12px;text-align:center}
footer a{color:var(--accent);text-decoration:none}
.provenance{margin:0 0 32px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:6px}
.provenance h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.provenance .src-list{margin:0;padding-left:18px;font-size:13px}
.provenance .src-list>li{margin:4px 0}
.provenance .src-kind{color:var(--muted);font-size:12px}
.provenance code{background:var(--paper);padding:1px 4px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.provenance ul ul{margin:2px 0;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<header>
<h1>${l(h)}</h1>
<div class="meta">${l(k||"Empty notebook")} \xB7 Exported ${l(x.slice(0,19).replace("T"," "))}</div>
</header>
${R(t.sources)}
${y}
${f.join(`
`)}
<footer>Prepared in NakliData \u2014 browser-native data workbench. Local data is processed in this browser; remote sources and cloud sidecar actions are explicit.</footer>
</main>
</body>
</html>
`,manifest:c}}function Q(t){return j(t).html}function l(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}export{j as buildStandaloneExport,Q as buildStandaloneHtml};
