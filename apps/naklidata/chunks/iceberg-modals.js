var u=class extends Error{code;constructor(t,e){super(t),this.name="SigV4Error",this.code=e}};function T(n,t=Date.now()){let{accessKeyId:e,secretAccessKey:a,sessionToken:o,expiresAtMs:r}=n;if(!/^[A-Z0-9]{16,128}$/.test(e)||!x(a,1024)||!x(o,8192))throw new u("AWS credentials must be a temporary access key, secret, and session token.","invalid_credentials");if(!Number.isSafeInteger(r)||r<=0)throw new u("AWS credentials need their STS expiration time.","invalid_credentials");if(r<=t)throw new u("AWS credentials have expired.","credentials_expired")}function x(n,t){if(typeof n!="string"||n.length===0||n.length>t)return!1;for(let e of n){let a=e.codePointAt(0)??0;if(a<=32||a===127)return!1}return!0}var I=/^[a-z]{2}(?:-[a-z]+)+-\d+$/,Z=/^arn:aws(?:-us-gov)?:s3tables:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:bucket\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,R=/^(?::|\d{12}(?::[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)?|[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/,k="Paste the JSON printed by `aws configure export-credentials --format process` or `aws sts assume-role`.";function C(n,t){let e=t.warehouse.trim();if(n==="aws-s3-tables"){let o=Z.exec(e)?.[1];if(!o)throw new Error("Enter the table bucket ARN, for example arn:aws:s3tables:us-east-1:111122223333:bucket/sales.");return{catalogUrl:`https://s3tables.${o}.amazonaws.com/iceberg`,warehouse:e,region:o}}let a=t.region.trim();if(!I.test(a))throw new Error("Enter an AWS Region, for example us-east-1.");if(!R.test(e))throw new Error('Enter the Glue catalog: an account id such as 111122223333, or ":" for yours.');return{catalogUrl:`https://glue.${a}.amazonaws.com/iceberg`,warehouse:e,region:a}}function H(n){let t;try{t=JSON.parse(n)}catch{throw new Error(k)}let e=$(t);if(!e)throw new Error(k);let a={accessKeyId:b(e.AccessKeyId),secretAccessKey:b(e.SecretAccessKey),sessionToken:b(e.SessionToken),expiresAtMs:M(b(e.Expiration))};return T(a),a}function M(n){let t=n.trim(),e=/(?:Z|[+-]\d{2}:\d{2})$/.test(t)?Date.parse(t):Number.NaN;if(!Number.isFinite(e))throw new Error("Enter the session expiration as an ISO time, for example 2026-10-01T10:25:42Z.");return e}function $(n){if(typeof n!="object"||n===null||Array.isArray(n))return null;let t=n,e=t.Credentials;return typeof e=="object"&&e!==null&&!Array.isArray(e)?e:t}function b(n){return typeof n=="string"?n.trim():""}var P={folder:"M216,72H130.66l-29.34-22a8,8,0,0,0-4.8-1.6H40A16,16,0,0,0,24,64V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V88A16,16,0,0,0,216,72Z",file:"M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34Z",plus:"M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z",table:"M224,48H32a8,8,0,0,0-8,8V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H88v32H40Zm64,0H216v32H104Zm112-16H40V64H216ZM40,160H88v40H40Zm64,40V160H216v40Z",chart:"M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0V156.69l50.34-50.35a8,8,0,0,1,11.32,0L128,140.69,180.69,88H160a8,8,0,0,1,0-16h40a8,8,0,0,1,8,8v40a8,8,0,0,1-16,0V99.31l-58.34,58.35a8,8,0,0,1-11.32,0L96,123.31l-56,56V200H224A8,8,0,0,1,232,208Z",database:"M128,24C74.17,24,32,48.6,32,80v96c0,31.4,42.17,56,96,56s96-24.6,96-56V80C224,48.6,181.83,24,128,24Zm0,16c41.7,0,80,18.31,80,40s-38.3,40-80,40S48,101.69,48,80,86.3,40,128,40Zm0,176c-41.7,0-80-18.31-80-40V117.07A126.39,126.39,0,0,0,128,136a126.39,126.39,0,0,0,80-18.93V176C208,197.69,169.7,216,128,216Z",play:"M232.4,114.49,88.32,26.35a16,16,0,0,0-24.32,14V216a16,16,0,0,0,24.32,13.65l144.08-88.14a15.9,15.9,0,0,0,0-27Z",check:"M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",x:"M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z",warning:"M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,52a12,12,0,1,1,12-12A12,12,0,0,1,128,196Z",info:"M128,24A104,104,0,1,0,232,128,104.13,104.13,0,0,0,128,24Zm-4,48a12,12,0,1,1-12,12A12,12,0,0,1,124,72Zm12,112a16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40a8,8,0,0,1,0,16Z",search:"M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z",caret:"M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z",link:"M134.71,189.19a4,4,0,0,1,0,5.66l-9.94,9.94a52,52,0,0,1-73.56-73.56l24.12-24.12a52,52,0,0,1,71.32-2.1,4,4,0,1,1-5.32,6A44,44,0,0,0,80.6,112.77L56.49,136.89a44,44,0,0,0,62.24,62.24l9.94-9.94A4,4,0,0,1,134.71,189.19ZM217.5,39.5a52,52,0,0,0-73.56,0l-9.94,9.94a4,4,0,1,0,5.66,5.66l9.94-9.94a44,44,0,0,1,62.24,62.24L187.74,131.5a44,44,0,0,1-60.66,1.4,4,4,0,1,0-5.32,6,52,52,0,0,0,71.32-2.1l24.12-24.12A52.06,52.06,0,0,0,217.5,39.5Z",download:"M224,152v56a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v56H208V152a8,8,0,0,1,16,0ZM90.34,114.34a8,8,0,0,1,11.32-11.32L120,121.37V40a8,8,0,0,1,16,0v81.37l18.34-18.35a8,8,0,0,1,11.32,11.32l-32,32a8,8,0,0,1-11.32,0Z",trash:"M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192Z",arrowRight:"M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z",pencil:"M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96A16,16,0,0,0,227.31,73.37ZM92.69,208H48V163.31l88-88L180.69,120Zm99.31-99.32L147.31,64l24-24L216,84.68Z",question:"M140,180a12,12,0,1,1-12-12A12,12,0,0,1,140,180ZM128,72c-22.06,0-40,16.15-40,36v4a8,8,0,0,0,16,0v-4c0-11,10.77-20,24-20s24,9,24,20-10.77,20-24,20a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-.72c18.24-3.35,32-17.9,32-35.28C168,88.15,150.06,72,128,72Z"};function f(n,t=16,e="currentColor"){return`<svg xmlns="http://www.w3.org/2000/svg" width="${t}" height="${t}" viewBox="0 0 256 256" fill="${e}" aria-hidden="true"><path d="${P[n]}"/></svg>`}function h(n,t){if(!n){t&&document.querySelector(`[data-action="${t}"]`)?.focus();return}if(n.isConnected&&(n.focus(),document.activeElement===n))return;let e=n.dataset?.action??t;e&&document.querySelector(`[data-action="${e}"]`)?.focus()}var F=["a[href]","button:not([disabled])",'input:not([disabled]):not([type="hidden"])',"select:not([disabled])","textarea:not([disabled])",'[tabindex]:not([tabindex="-1"])'].join(",");var i=null,S=null,d=null,w=null;function U(n){if(i&&document.body.contains(i))return;S=document.activeElement??null;let t=_(n);document.body.append(t),i=t,t.querySelector('[data-region="catalog-url-input"]')?.focus()}function v(){w?.abort("Iceberg catalog mount dialog closed"),w=null,i?.parentElement&&i.parentElement.removeChild(i),i=null,d&&(document.removeEventListener("keydown",d),d=null),h(S),S=null}function _(n){let t=document.createElement("div");return t.className="schema-graph-overlay mount-iceberg-catalog-overlay",t.setAttribute("role","dialog"),t.setAttribute("aria-modal","true"),t.setAttribute("aria-label","Mount Iceberg via REST Catalog"),t.innerHTML=`
    <div class="schema-graph-modal mount-iceberg-modal" data-region="mount-iceberg-catalog-modal">
      <div class="schema-graph-header">
        <strong>Mount Iceberg via REST Catalog</strong>
        <button class="btn btn-ghost schema-graph-close" data-action="close-mount-iceberg-catalog" aria-label="Close">
          ${f("x",14)}
        </button>
      </div>
      <div class="mount-s3-body">
        <label class="mount-url-field">
          <span>Catalog</span>
          <select data-region="catalog-provider-select">
            <option value="rest">Iceberg REST catalog (Bearer token or public)</option>
            <option value="aws-glue">AWS Glue Data Catalog</option>
            <option value="aws-s3-tables">Amazon S3 Tables</option>
          </select>
        </label>
        <div data-provider-section="rest">
          <label class="mount-url-field">
            <span>Catalog URL <em>(base URL \u2014 we append /v1/...)</em></span>
            <input type="url" data-region="catalog-url-input" placeholder="https://lakehouse.example.com/iceberg" autocomplete="off" spellcheck="false">
          </label>
          <label class="mount-url-field">
            <span>REST warehouse / catalog identifier <em>(optional \u2014 required by Polaris and some servers)</em></span>
            <input type="text" data-region="warehouse-input" placeholder="quickstart_catalog" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <div class="mount-s3-row" data-provider-section="aws-glue" hidden>
          <label class="mount-url-field">
            <span>AWS Region</span>
            <input type="text" data-region="aws-region-input" placeholder="us-east-1" autocomplete="off" spellcheck="false">
          </label>
          <label class="mount-url-field">
            <span>Glue catalog <em>(account id, or ":" for yours)</em></span>
            <input type="text" data-region="aws-glue-catalog-input" placeholder="111122223333" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <label class="mount-url-field" data-provider-section="aws-s3-tables" hidden>
          <span>Table bucket ARN <em>(the Region comes from the ARN)</em></span>
          <input type="text" data-region="aws-table-bucket-arn-input" placeholder="arn:aws:s3tables:us-east-1:111122223333:bucket/sales" autocomplete="off" spellcheck="false">
        </label>
        <div class="mount-s3-row">
          <label class="mount-url-field">
            <span>Namespace <em>(dot-separated for nested)</em></span>
            <input type="text" data-region="namespace-input" placeholder="analytics" autocomplete="off" spellcheck="false">
          </label>
          <label class="mount-url-field">
            <span>Table</span>
            <input type="text" data-region="table-input" placeholder="sales" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <div data-provider-section="rest">
          <label class="mount-url-field">
            <span>Bearer token <em>(optional \u2014 leave blank for public catalogs; applies to all data requests this session)</em></span>
            <input type="password" data-region="bearer-token-input" autocomplete="off" spellcheck="false">
          </label>
          <label class="mount-url-field mount-s3-remember">
            <input type="checkbox" data-region="remember-input">
            <span>Remember token on this device <em>\u2014 stored plaintext in IndexedDB on this origin. Anyone with access to this browser profile can read it.</em></span>
          </label>
        </div>
        <div data-provider-section="aws" hidden>
          <label class="mount-url-field">
            <span>Paste a temporary AWS session <em>(JSON from <code>aws configure export-credentials --format process</code>; fills the fields below)</em></span>
            <input type="password" data-region="aws-session-json-input" autocomplete="off" spellcheck="false">
          </label>
          <p class="mount-url-hint" data-region="aws-session-status" hidden></p>
          <div class="mount-s3-row">
            <label class="mount-url-field">
              <span>Access key id</span>
              <input type="text" data-region="aws-access-key-input" placeholder="ASIA\u2026" autocomplete="off" spellcheck="false">
            </label>
            <label class="mount-url-field">
              <span>Session expiration <em>(ISO time)</em></span>
              <input type="text" data-region="aws-expiration-input" placeholder="2026-10-01T10:25:42Z" autocomplete="off" spellcheck="false">
            </label>
          </div>
          <label class="mount-url-field">
            <span>Secret access key</span>
            <input type="password" data-region="aws-secret-key-input" autocomplete="off" spellcheck="false">
          </label>
          <label class="mount-url-field">
            <span>Session token</span>
            <input type="password" data-region="aws-session-token-input" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <label class="mount-url-field">
          <span>Label <em>(optional)</em></span>
          <input type="text" data-region="label-input" placeholder="defaults to namespace.table" autocomplete="off" spellcheck="false">
        </label>
        <p class="mount-url-hint">
          The catalog resolves the table's current metadata-location each time
          you reload, so fresh snapshots are picked up automatically.
        </p>
        <p class="mount-url-hint" data-provider-section="rest">
          Bearer tokens are supported; OAuth2 sign-in is not supported yet.
          Release-verified profiles today are AWS Glue and Amazon S3 Tables;
          other REST catalogs are unverified.
        </p>
        <p class="mount-url-hint" data-provider-section="aws" hidden>
          AWS catalogs take a temporary session only, never long-term keys.
          Requests are signed in this tab and go straight to AWS. The session
          is kept in memory for this tab and never saved; after a reload you
          paste a fresh one.
        </p>
        <div class="mount-url-error" data-region="error" hidden></div>
        <div class="mount-url-actions">
          <button class="btn btn-ghost" data-action="close-mount-iceberg-catalog">Cancel</button>
          <button class="btn btn-primary" data-action="confirm-mount-iceberg-catalog">Mount</button>
        </div>
      </div>
    </div>
  `,t.querySelector('[data-region="catalog-provider-select"]')?.addEventListener("change",e=>{V(t,e.target.value)}),t.querySelector('[data-region="aws-session-json-input"]')?.addEventListener("input",e=>q(t,e.target)),t.addEventListener("click",e=>{let a=e.target;a&&(a===t&&v(),a.closest('[data-action="close-mount-iceberg-catalog"]')&&v(),a.closest('[data-action="confirm-mount-iceberg-catalog"]')&&K(t,n))}),d=e=>{e.key==="Escape"&&v()},document.addEventListener("keydown",d),t}function V(n,t){let e=t!=="rest";for(let a of n.querySelectorAll("[data-provider-section]")){let o=a.dataset.providerSection;a.hidden=!(o===t||e&&o==="aws")}}function q(n,t){let e=n.querySelector('[data-region="aws-session-status"]');if(t.value.trim()){try{let a=H(t.value),o=(r,l)=>{let m=n.querySelector(`[data-region="${r}"]`);m&&(m.value=l)};o("aws-access-key-input",a.accessKeyId),o("aws-secret-key-input",a.secretAccessKey),o("aws-session-token-input",a.sessionToken),o("aws-expiration-input",new Date(a.expiresAtMs).toISOString()),e&&(e.textContent=`Session filled; it expires ${new Date(a.expiresAtMs).toISOString()}.`,e.hidden=!1)}catch(a){e&&(e.textContent=a instanceof Error?a.message:"That session could not be read.",e.hidden=!1)}t.value=""}}function z(n){return{accessKeyId:n("aws-access-key-input")?.value.trim()??"",secretAccessKey:n("aws-secret-key-input")?.value.trim()??"",sessionToken:n("aws-session-token-input")?.value.trim()??"",expiresAtMs:M(n("aws-expiration-input")?.value??"")}}async function K(n,t){let e=s=>n.querySelector(`[data-region="${s}"]`),a=n.querySelector('[data-region="error"]'),o=(s,g=null)=>{a&&(a.textContent=s,a.hidden=!1),g&&e(g)?.focus()},r=n.querySelector('[data-region="catalog-provider-select"]')?.value??"rest",l={provider:r,label:e("label-input")?.value.trim()??"",catalogUrl:e("catalog-url-input")?.value.trim()??"",warehouse:e("warehouse-input")?.value.trim()??"",namespace:e("namespace-input")?.value.trim()??"",table:e("table-input")?.value.trim()??"",bearerToken:e("bearer-token-input")?.value??"",remember:e("remember-input")?.checked??!1,awsCredentials:null};if(r!=="rest")try{let s=C(r,{region:e("aws-region-input")?.value??"",warehouse:e(r==="aws-glue"?"aws-glue-catalog-input":"aws-table-bucket-arn-input")?.value??""});l.catalogUrl=s.catalogUrl,l.warehouse=s.warehouse,l.awsCredentials=z(e),l.bearerToken="",l.remember=!1}catch(s){o(s instanceof Error?s.message:String(s));return}let m=[["catalogUrl","Catalog URL","catalog-url-input"],["namespace","Namespace","namespace-input"],["table","Table","table-input"]];for(let[s,g,L]of m)if(!String(l[s]).trim()){o(`${g} is required.`,L);return}a&&(a.textContent="",a.hidden=!0);try{w?.abort("Iceberg catalog mount replaced");let s=new AbortController;w=s,await t.onMount(l,s.signal),v()}catch(s){a&&(a.textContent=s instanceof Error?s.message:String(s),a.hidden=!1)}}var c=null,E=null,p=null,A=null;function N(n){if(c&&document.body.contains(c))return;E=document.activeElement??null;let t=O(n);document.body.append(t),c=t,t.querySelector('[data-region="metadata-url-input"]')?.focus()}function y(){A?.abort("Iceberg mount dialog closed"),A=null,c?.parentElement&&c.parentElement.removeChild(c),c=null,p&&(document.removeEventListener("keydown",p),p=null),h(E),E=null}function O(n){let t=document.createElement("div");return t.className="schema-graph-overlay mount-iceberg-overlay",t.setAttribute("role","dialog"),t.setAttribute("aria-modal","true"),t.setAttribute("aria-label","Mount Iceberg table"),t.innerHTML=`
    <div class="schema-graph-modal mount-iceberg-modal" data-region="mount-iceberg-modal">
      <div class="schema-graph-header">
        <strong>Mount Iceberg table</strong>
        <button class="btn btn-ghost schema-graph-close" data-action="close-mount-iceberg" aria-label="Close">
          ${f("x",14)}
        </button>
      </div>
      <div class="mount-s3-body">
        <label class="mount-url-field">
          <span>Metadata URL <em>(metadata.json or its directory)</em></span>
          <input type="url" data-region="metadata-url-input" placeholder="https://my-bucket.s3.amazonaws.com/warehouse/sales/metadata/v3.metadata.json" autocomplete="off" spellcheck="false">
        </label>
        <label class="mount-url-field">
          <span>Bearer token <em>(not released for this public-only path)</em></span>
          <input type="password" data-region="bearer-token-input" autocomplete="off" spellcheck="false" disabled>
        </label>
        <label class="mount-url-field mount-s3-remember">
          <input type="checkbox" data-region="remember-input" disabled>
          <span>Private bearer access remains verification-gated.</span>
        </label>
        <label class="mount-url-field">
          <span>Label <em>(optional)</em></span>
          <input type="text" data-region="label-input" placeholder="defaults to the table directory name" autocomplete="off" spellcheck="false">
        </label>
        <p class="mount-url-hint">
          Mounts one public Iceberg table from an HTTPS metadata URL or table
          directory. The source must permit browser CORS reads. Private bearer,
          S3, GCS, OAuth2, and AWS Glue profiles remain verification-gated.
        </p>
        <div class="mount-url-error" data-region="error" hidden></div>
        <div class="mount-url-actions">
          <button class="btn btn-ghost" data-action="close-mount-iceberg">Cancel</button>
          <button class="btn btn-primary" data-action="confirm-mount-iceberg">Mount</button>
        </div>
      </div>
    </div>
  `,t.addEventListener("click",e=>{let a=e.target;a&&(a===t&&y(),a.closest('[data-action="close-mount-iceberg"]')&&y(),a.closest('[data-action="confirm-mount-iceberg"]')&&j(t,n))}),p=e=>{e.key==="Escape"&&y()},document.addEventListener("keydown",p),t}async function j(n,t){let e=r=>n.querySelector(`[data-region="${r}"]`),a=n.querySelector('[data-region="error"]'),o={label:e("label-input")?.value.trim()??"",metadataUrl:e("metadata-url-input")?.value.trim()??"",bearerToken:e("bearer-token-input")?.value??"",remember:e("remember-input")?.checked??!1};if(!o.metadataUrl){a&&(a.textContent="Metadata URL is required.",a.hidden=!1),e("metadata-url-input")?.focus();return}if(!o.metadataUrl.toLowerCase().startsWith("https://")){a&&(a.textContent="The released table path requires a public https:// URL.",a.hidden=!1),e("metadata-url-input")?.focus();return}a&&(a.textContent="",a.hidden=!0);try{A?.abort("Iceberg mount replaced");let r=new AbortController;A=r,await t.onMount(o,r.signal),y()}catch(r){a&&(a.textContent=r instanceof Error?r.message:String(r),a.hidden=!1)}}export{U as openMountIcebergCatalogModal,N as openMountIcebergModal};
