var T={top:20,right:20,bottom:20,left:20};function O(){return{title:"Report",pageSize:"A4",margins:T,items:[]}}var N=["%m/%d/%Y %H:%M","%m/%d/%Y","%d/%m/%Y %H:%M","%d/%m/%Y","%B %d, %Y","%b %d, %Y","%d %B %Y","%Y/%m/%d"];function C(e){let t=N.map(o=>`'${o}'`).join(", ");return`COALESCE(TRY_CAST(${e} AS TIMESTAMP), try_strptime(${e}, [${t}]))`}function U(e,t){let o={};for(let u of t)for(let d of u.tables)o[d.id]=d.name;let r=u=>{let d=u.assigned.confidence;return(u.assigned.origin==="user_accept"||u.assigned.origin==="user_override")&&(d+=.5),d},a={};for(let[u,d]of Object.entries(e)){if(!d.assigned.typeId)continue;let[,_]=u.split("::"),s=_?o[_]:void 0;if(!s)continue;let f=a[d.assigned.typeId]??[];f.push({table:s,column:d.columnName,score:r(d)}),a[d.assigned.typeId]=f}let i={};for(let u of Object.values(a)){let d=new Set;for(let _ of u)d.has(_.table)||(i[_.table]=(i[_.table]??0)+1,d.add(_.table))}let c={};for(let[u,d]of Object.entries(a)){d.sort((s,f)=>{if(f.score!==s.score)return f.score-s.score;let g=i[s.table]??0,y=i[f.table]??0;return y!==g?y-g:f.column.length-s.column.length});let _=d[0];_&&(c[u]={table:_.table,column:_.column})}return c}function D(e,t,o,r){let a=[];for(let i of e){if(i.requiredRoleFamilies&&i.requiredRoleFamilies.length>0){if(!r)continue;let s={};for(let b of i.requiredRoleFamilies)s[b]=[];for(let[b,S]of Object.entries(t)){let R=r(b);R&&s[R]&&s[R].push(S)}let f=b=>new Set((s[b]??[]).map(S=>S.table)),g=null;for(let b of f(i.requiredRoleFamilies[0]))if(i.requiredRoleFamilies.every(S=>f(S).has(b))){g=b;break}if(!g)continue;let y={};for(let b of i.requiredRoleFamilies)y[b]=(s[b]??[]).find(S=>S.table===g);A(y,i.optionalTypes??[],g,o,t),a.push({template:i,matched:y});continue}if(i.requiredTypes.length===0){let s={},f=I(i.optionalTypes??[],o);A(s,i.optionalTypes??[],f,o,t),a.push({template:i,matched:s});continue}let c=o?F(i.requiredTypes,o):null;if(c){let s={...c},f=Object.values(c)[0]?.table??null;if(A(s,i.optionalTypes??[],f,o,t),i.companion){let g=o?i.companion(o,s):null;if(!g)continue;Object.assign(s,g)}a.push({template:i,matched:s});continue}if(i.companion||!i.requiredTypes.every(s=>t[s]!==void 0))continue;let d={};for(let s of i.requiredTypes)d[s]=t[s];let _=new Set(i.requiredTypes.map(s=>d[s]?.table).filter(s=>!!s));_.size===1&&(A(d,i.optionalTypes??[],_.values().next().value??null,o,t),a.push({template:i,matched:d}))}return a}function A(e,t,o,r,a){for(let i of t){let c=r?.[i]??[],u=o?c.filter(_=>_.table===o).sort((_,s)=>s.score-_.score)[0]:void 0,d=a[i];e[i]=(u?{table:u.table,column:u.column}:void 0)??(d&&(!o||d.table===o)?d:void 0)}}function I(e,t){if(!t)return null;let o=new Map;for(let r of e){let a=new Map;for(let i of t[r]??[])a.set(i.table,Math.max(a.get(i.table)??-1,i.score));for(let[i,c]of a){let u=o.get(i)??{coverage:0,score:0};o.set(i,{coverage:u.coverage+1,score:u.score+c})}}return[...o.entries()].sort(([r,a],[i,c])=>c.coverage-a.coverage||c.score-a.score||r.localeCompare(i))[0]?.[0]??null}function F(e,t){let o={};for(let a of e){let i=t[a]??[];for(let c of i){let u=o[c.table]??{total:0,picks:{},scores:{}},d=u.scores[a]??-1;c.score>d&&(u.picks[a]={table:c.table,column:c.column},u.scores[a]=c.score,u.total+=c.score-Math.max(d,0)),o[c.table]=u}}let r=null;for(let[a,i]of Object.entries(o))Object.keys(i.picks).length===e.length&&(!r||i.total>r.total)&&(r={table:a,total:i.total,picks:i.picks});return r?r.picks:null}function k(e,t){let o={};for(let c of t)for(let u of c.tables)o[u.id]=u.name;let r=c=>{let u=c.assigned.confidence;return(c.assigned.origin==="user_accept"||c.assigned.origin==="user_override")&&(u+=.5),u},a={};for(let[c,u]of Object.entries(e)){if(!u.assigned.typeId)continue;let[,d]=c.split("::"),_=d?o[d]:void 0;if(!_)continue;let s=a[u.assigned.typeId]??[];s.push({table:_,column:u.columnName,score:r(u)}),a[u.assigned.typeId]=s}return{byType:U(e,t),perType:a}}function n(e){return`"${e.replace(/"/g,'""')}"`}function l(e,t){return{id:"",kind:"sql",name:e,code:t,status:"idle",lastError:null,lastResult:null}}function p(e){return{id:"",kind:"markdown",name:null,code:e}}function m(e,t,o,r){return{id:"",kind:"chart",name:null,inputCell:null,chartType:e,x:o,y:r,facet:null,_intendedInputName:t||null}}var w={id:"ar_aging",name:"AR aging",description:"Bucket open invoices by days overdue. Requires invoice date + amount + vendor.",requiredTypes:["iso_date","amount","vendor_name"],instantiate(e){let t=e.iso_date,o=e.amount,r=e.vendor_name;return[p(`# AR aging

Open amounts by overdue bucket.`),l("open_invoices",`SELECT ${n(r.column)} AS vendor, ${n(t.column)} AS invoice_date, ${n(o.column)} AS amount,
       DATE_DIFF('day', CAST(${n(t.column)} AS DATE), CURRENT_DATE) AS days_overdue
FROM ${n(t.table)}
ORDER BY days_overdue DESC`),l("ar_aging",`SELECT
  CASE
    WHEN days_overdue <= 0 THEN '0 (not yet due)'
    WHEN days_overdue <= 30 THEN '1-30'
    WHEN days_overdue <= 60 THEN '31-60'
    WHEN days_overdue <= 90 THEN '61-90'
    ELSE '90+'
  END AS bucket,
  SUM(amount) AS total_amount,
  COUNT(*) AS invoice_count
FROM @open_invoices
GROUP BY 1
ORDER BY 1`),m("bar","ar_aging","bucket","total_amount")]}},B={id:"vendor_concentration",name:"Vendor concentration",description:"Top vendors by spend. Pareto-style.",requiredTypes:["vendor_name","amount"],instantiate(e){let t=e.vendor_name,o=e.amount;return[p(`# Vendor concentration

Top vendors by total spend.`),l("vendor_spend",`SELECT ${n(t.column)} AS vendor, SUM(${n(o.column)}) AS total
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total DESC
LIMIT 20`),m("bar","vendor_spend","vendor","total")]}},L={id:"gst_recon",name:"GSTIN spend by state",description:"Aggregate spend per vendor GSTIN, with the state derived from the first two digits.",requiredTypes:["gstin","amount"],instantiate(e){let t=e.gstin,o=e.amount;return[p(`# GSTIN spend by state

GSTIN[0..2] is the state code (per CBIC).`),l("gst_by_state",`SELECT SUBSTR(${n(t.column)}, 1, 2) AS state_code, SUM(${n(o.column)}) AS total, COUNT(*) AS n
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total DESC`),m("bar","gst_by_state","state_code","total")]}},x={id:"error_frequency",name:"Error frequency by service",description:"Time-binned error counts per service.",requiredTypes:["log_level","service_name","iso_datetime"],instantiate(e){let t=e.log_level,o=e.service_name,r=e.iso_datetime;return[p("# Error frequency by service"),l("errors_by_service",`SELECT ${n(o.column)} AS service, COUNT(*) AS n
FROM ${n(t.table)}
WHERE LOWER(${n(t.column)}) IN ('error', 'err', 'fatal', 'crit', 'critical')
GROUP BY 1
ORDER BY n DESC`),l("errors_over_time",`SELECT DATE_TRUNC('hour', CAST(${n(r.column)} AS TIMESTAMP)) AS hour, COUNT(*) AS errors
FROM ${n(t.table)}
WHERE LOWER(${n(t.column)}) IN ('error', 'err', 'fatal', 'crit', 'critical')
GROUP BY 1
ORDER BY 1`),m("bar","errors_by_service","service","n"),m("line","errors_over_time","hour","errors")]}},P={id:"p95_p99",name:"P95 / P99 latency",description:"Latency quantiles per endpoint.",requiredTypes:["endpoint","duration_ms"],instantiate(e){let t=e.endpoint,o=e.duration_ms;return[p("# P95 / P99 latency by endpoint"),l("latency_quantiles",`SELECT ${n(t.column)} AS endpoint,
       quantile_cont(${n(o.column)}, 0.50) AS p50,
       quantile_cont(${n(o.column)}, 0.95) AS p95,
       quantile_cont(${n(o.column)}, 0.99) AS p99,
       COUNT(*) AS n
FROM ${n(t.table)}
GROUP BY 1
ORDER BY p99 DESC`),m("bar","latency_quantiles","endpoint","p99")]}},Y={id:"dau",name:"Daily active users (DAU)",description:"Distinct users per day from your event stream.",requiredTypes:["iso_datetime","user_id"],instantiate(e){let t=e.iso_datetime,o=e.user_id;return[p(`# Daily active users

Distinct users with at least one event per day.`),l("dau",`SELECT DATE_TRUNC('day', CAST(${n(t.column)} AS TIMESTAMP)) AS day,
       COUNT(DISTINCT ${n(o.column)}) AS dau
FROM ${n(t.table)}
GROUP BY 1
ORDER BY 1`),m("line","dau","day","dau")]}},q={id:"top_events_by_user",name:"Top events by user-count",description:"Which event names drive the most unique users.",requiredTypes:["event_name","user_id"],instantiate(e){let t=e.event_name,o=e.user_id;return[p(`# Top events by user-count

Each row counts distinct users who fired that event at least once. Drives the "what does this product actually do?" question on a fresh dataset.`),l("top_events_by_user",`SELECT ${n(t.column)} AS event_name,
       COUNT(DISTINCT ${n(o.column)}) AS unique_users,
       COUNT(*) AS occurrences
FROM ${n(t.table)}
GROUP BY 1
ORDER BY unique_users DESC
LIMIT 20`),m("bar","top_events_by_user","event_name","unique_users")]}},G={id:"funnel_a_b_c",name:"Funnel: A \u2192 B \u2192 C",description:"Three-step conversion funnel. Pick the steps in the SQL (the seed picks the three most common event names).",requiredTypes:["event_name","user_id","iso_datetime"],instantiate(e){let t=e.event_name,o=e.user_id,r=e.iso_datetime;return[p("# Funnel: A \u2192 B \u2192 C\n\nThree-step conversion. The seed query auto-picks the three most-common event names; edit the `step_a`, `step_b`, `step_c` selections to point at your real funnel. Users must hit step B *after* step A and step C *after* step B."),l("funnel_steps",`-- Edit these three event names to match your real funnel:
WITH step_a AS (
  SELECT ${n(o.column)} AS user_id, MIN(CAST(${n(r.column)} AS TIMESTAMP)) AS t_a
  FROM ${n(t.table)}
  WHERE ${n(t.column)} = (
    SELECT ${n(t.column)} FROM ${n(t.table)}
    GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1
  )
  GROUP BY 1
),
step_b AS (
  SELECT a.user_id, MIN(CAST(b.${n(r.column)} AS TIMESTAMP)) AS t_b
  FROM step_a a
  JOIN ${n(t.table)} b
    ON b.${n(o.column)} = a.user_id
   AND b.${n(t.column)} = (
     SELECT ${n(t.column)} FROM ${n(t.table)}
     GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1 OFFSET 1
   )
   AND CAST(b.${n(r.column)} AS TIMESTAMP) > a.t_a
  GROUP BY a.user_id
),
step_c AS (
  SELECT b.user_id, MIN(CAST(c.${n(r.column)} AS TIMESTAMP)) AS t_c
  FROM step_b b
  JOIN ${n(t.table)} c
    ON c.${n(o.column)} = b.user_id
   AND c.${n(t.column)} = (
     SELECT ${n(t.column)} FROM ${n(t.table)}
     GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1 OFFSET 2
   )
   AND CAST(c.${n(r.column)} AS TIMESTAMP) > b.t_b
  GROUP BY b.user_id
)
SELECT 'A: ' || (SELECT ${n(t.column)} FROM ${n(t.table)} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1) AS step, COUNT(*) AS users FROM step_a
UNION ALL
SELECT 'B: ' || (SELECT ${n(t.column)} FROM ${n(t.table)} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1 OFFSET 1), COUNT(*) FROM step_b
UNION ALL
SELECT 'C: ' || (SELECT ${n(t.column)} FROM ${n(t.table)} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1 OFFSET 2), COUNT(*) FROM step_c`),m("funnel","funnel_steps","step","users")]}},H={id:"top_paths",name:"Top user paths",description:"Most common 3-event sequences users take.",requiredTypes:["event_name","user_id","iso_datetime"],instantiate(e){let t=e.event_name,o=e.user_id,r=e.iso_datetime;return[p(`# Top user paths

Each path = the first three events a user fires, in time order. Sankey is overkill for the eyeball question "what do users actually do?"; a top-20 list of triplets answers it cleaner.`),l("top_paths",`WITH ordered AS (
  SELECT ${n(o.column)} AS user_id,
         ${n(t.column)} AS event,
         CAST(${n(r.column)} AS TIMESTAMP) AS ts,
         ROW_NUMBER() OVER (PARTITION BY ${n(o.column)} ORDER BY CAST(${n(r.column)} AS TIMESTAMP)) AS rn
  FROM ${n(t.table)}
),
triplets AS (
  SELECT a.user_id,
         a.event || ' \u2192 ' || b.event || ' \u2192 ' || c.event AS path
  FROM ordered a
  JOIN ordered b ON b.user_id = a.user_id AND b.rn = 2
  JOIN ordered c ON c.user_id = a.user_id AND c.rn = 3
  WHERE a.rn = 1
)
SELECT path, COUNT(*) AS users
FROM triplets
GROUP BY 1
ORDER BY users DESC
LIMIT 20`),m("path","top_paths","path","users")]}},V={id:"retention_30d",name:"30-day retention (cohort)",description:"For each weekly cohort, how many came back N weeks later.",requiredTypes:["iso_datetime","user_id"],instantiate(e){let t=e.iso_datetime,o=e.user_id;return[p(`# 30-day retention

Rows = the week each user first appeared (cohort). Columns = how many weeks after that week. Cells = how many of that cohort came back. The heatmap reads top-left dense if your retention is strong.`),l("retention_cohort",`WITH first_seen AS (
  SELECT ${n(o.column)} AS user_id,
         DATE_TRUNC('week', MIN(CAST(${n(t.column)} AS TIMESTAMP))) AS cohort_week
  FROM ${n(t.table)}
  GROUP BY 1
),
activity AS (
  SELECT e.${n(o.column)} AS user_id,
         DATE_TRUNC('week', CAST(e.${n(t.column)} AS TIMESTAMP)) AS active_week
  FROM ${n(t.table)} e
  GROUP BY 1, 2
)
SELECT f.cohort_week,
       DATEDIFF('week', f.cohort_week, a.active_week) AS week_offset,
       COUNT(DISTINCT a.user_id) AS users
FROM first_seen f
JOIN activity a ON a.user_id = f.user_id
WHERE DATEDIFF('week', f.cohort_week, a.active_week) BETWEEN 0 AND 4
GROUP BY 1, 2
ORDER BY 1, 2`),m("heatmap","retention_cohort","week_offset","cohort_week")]}},W={id:"conversion_by_source",name:"Conversion rate by source",description:"For each UTM source, what fraction of users converted (default: signup event).",requiredTypes:["utm_source","event_name","user_id"],instantiate(e){let t=e.utm_source,o=e.event_name,r=e.user_id;return[p("# Conversion rate by source\n\nThe seed query treats `signup` as the conversion. Edit the SQL to point at your real conversion event (`purchase`, `subscribe`, `complete_onboarding`, \u2026)."),l("conversion_by_source",`WITH source_users AS (
  SELECT ${n(t.column)} AS source,
         ${n(r.column)} AS user_id
  FROM ${n(t.table)}
  GROUP BY 1, 2
),
converted AS (
  SELECT DISTINCT ${n(r.column)} AS user_id
  FROM ${n(o.table)}
  WHERE LOWER(${n(o.column)}) = 'signup'
)
SELECT su.source,
       COUNT(DISTINCT su.user_id) AS users,
       COUNT(DISTINCT c.user_id) AS converters,
       ROUND(100.0 * COUNT(DISTINCT c.user_id) / NULLIF(COUNT(DISTINCT su.user_id), 0), 2) AS conversion_pct
FROM source_users su
LEFT JOIN converted c ON c.user_id = su.user_id
GROUP BY 1
HAVING COUNT(DISTINCT su.user_id) >= 5
ORDER BY conversion_pct DESC`),m("bar","conversion_by_source","source","conversion_pct")]}},K={id:"marketplace_supply",name:"Marketplace supply and price brief",description:"Supply and average price by listing/room type, with an optional geography cut. Fits Airbnb-style listing exports.",requiredTypes:["room_type","amount"],optionalTypes:["state_region","availability_days","review_count"],instantiate(e){let t=e.room_type,o=e.amount,r=e.state_region,a=[p(`# Marketplace supply and price brief

Listings and average price by room type.`),l("supply_by_type",`SELECT ${n(t.column)} AS room_type,
       COUNT(*) AS listings,
       ROUND(AVG(${n(o.column)}), 2) AS avg_price
FROM ${n(t.table)}
GROUP BY 1
ORDER BY listings DESC`),m("bar","supply_by_type","room_type","listings")];return r&&a.push(l("supply_by_region",`SELECT ${n(r.column)} AS region,
       COUNT(*) AS listings,
       ROUND(AVG(${n(o.column)}), 2) AS avg_price
FROM ${n(r.table)}
GROUP BY 1
ORDER BY listings DESC
LIMIT 20`),m("bar","supply_by_region","region","listings")),a}},z={id:"outcome_comparison",name:"Outcome comparison brief",description:"Compare an outcome rate across a categorical group (e.g. survival by passenger class). Fits Titanic-style datasets.",requiredTypes:["survival_flag","passenger_class"],optionalTypes:["sex_gender"],instantiate(e){let t=e.survival_flag,o=e.passenger_class,r=e.sex_gender,a=[p(`# Outcome comparison brief

Outcome rate by group.`),l("outcome_by_group",`SELECT ${n(o.column)} AS grp,
       COUNT(*) AS n,
       ROUND(AVG(CAST(${n(t.column)} AS DOUBLE)), 3) AS outcome_rate
FROM ${n(o.table)}
GROUP BY 1
ORDER BY 1`),m("bar","outcome_by_group","grp","outcome_rate")];return r&&a.push(l("outcome_by_group_sex",`SELECT ${n(o.column)} AS grp,
       ${n(r.column)} AS sex,
       COUNT(*) AS n,
       ROUND(AVG(CAST(${n(t.column)} AS DOUBLE)), 3) AS outcome_rate
FROM ${n(o.table)}
GROUP BY 1, 2
ORDER BY 1, 2`)),a}},j={id:"geo_distribution",name:"Geography distribution brief",description:"Record counts (and total amount, if present) by state/region. Fits any dataset with a geography column.",requiredTypes:["state_region"],optionalTypes:["amount","room_type"],instantiate(e){let t=e.state_region,o=e.amount,r=o?`,
       ROUND(SUM(${n(o.column)}), 2) AS total_amount`:"";return[p(`# Geography distribution brief

Records by region.`),l("by_region",`SELECT ${n(t.column)} AS region,
       COUNT(*) AS records${r}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY records DESC
LIMIT 25`),m("bar","by_region","region","records")]}},J={id:"amount_summary",name:"Amount summary",description:"Total of the main amount/metric column \u2014 as a monthly trend when a date column is present.",requiredTypes:["amount"],optionalTypes:["iso_datetime","iso_date"],instantiate(e){let t=e.amount,o=e.iso_datetime??e.iso_date;return o?[p(`# Amount over time

Monthly total of the main amount column.`),l("amount_over_time",`SELECT DATE_TRUNC('month', ${C(n(o.column))}) AS month,
       SUM(${n(t.column)}) AS total, COUNT(*) AS records
FROM ${n(t.table)}
WHERE ${C(n(o.column))} IS NOT NULL
GROUP BY 1
ORDER BY 1`),m("line","amount_over_time","month","total")]:[p(`# Amount summary

Total and average of the main amount column.`),l("amount_totals",`SELECT COUNT(*) AS records, ROUND(SUM(${n(t.column)}), 2) AS total,
       ROUND(AVG(${n(t.column)}), 2) AS average
FROM ${n(t.table)}`)]}},Q={id:"retail_sales",name:"Retail sales brief",description:"Revenue (quantity \xD7 price), units, and order lines \u2014 broken out by country when present. Fits retail / e-commerce transaction exports.",requiredTypes:["quantity","amount"],optionalTypes:["country_name","sku"],instantiate(e){let t=e.quantity,o=e.amount,r=e.country_name,a=[p(`# Retail sales brief

Revenue = quantity \xD7 price.`)];return r?a.push(l("revenue_by_country",`SELECT ${n(r.column)} AS country,
       ROUND(SUM(${n(t.column)} * ${n(o.column)}), 2) AS revenue,
       SUM(${n(t.column)}) AS units,
       COUNT(*) AS lines
FROM ${n(t.table)}
GROUP BY 1
ORDER BY revenue DESC
LIMIT 20`),m("bar","revenue_by_country","country","revenue")):a.push(l("revenue_totals",`SELECT ROUND(SUM(${n(t.column)} * ${n(o.column)}), 2) AS revenue,
       SUM(${n(t.column)}) AS units,
       COUNT(*) AS lines
FROM ${n(t.table)}`)),a}},X={id:"content_catalog",name:"Content catalog brief",description:"Title counts by release year, with media-type and content-rating breakdowns when present. Fits streaming / catalog exports.",requiredTypes:["content_title","release_year"],optionalTypes:["media_type","content_rating"],instantiate(e){let t=e.release_year,o=e.media_type,r=e.content_rating,a=[p(`# Content catalog brief

Titles by release year.`),l("titles_by_year",`SELECT ${n(t.column)} AS release_year, COUNT(*) AS titles
FROM ${n(t.table)}
GROUP BY 1
ORDER BY 1`),m("bar","titles_by_year","release_year","titles")];return o&&a.push(l("titles_by_type",`SELECT ${n(o.column)} AS media_type, COUNT(*) AS titles
FROM ${n(o.table)}
GROUP BY 1
ORDER BY titles DESC`),m("bar","titles_by_type","media_type","titles")),r&&a.push(l("titles_by_rating",`SELECT ${n(r.column)} AS rating, COUNT(*) AS titles
FROM ${n(r.table)}
GROUP BY 1
ORDER BY titles DESC
LIMIT 20`)),a}};var Z={id:"hr_workforce",name:"Workforce brief",description:"Headcount and average compensation by department \u2014 with average tenure when present. Fits HRIS / people-analytics exports.",requiredTypes:["department","compensation"],optionalTypes:["tenure_years"],instantiate(e){let t=e.department,o=e.compensation,r=e.tenure_years,a=r?`,
       ROUND(AVG(${n(r.column)}), 1) AS avg_tenure_years`:"";return[p(`# Workforce brief

Headcount and average compensation by department.`),l("workforce_by_department",`SELECT ${n(t.column)} AS department,
       COUNT(*) AS headcount,
       ROUND(AVG(${n(o.column)}), 0) AS avg_compensation${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY headcount DESC
LIMIT 30`),m("bar","workforce_by_department","department","headcount")]}},ee={id:"real_estate_inventory",name:"Inventory and price brief",description:"Listing count and average sale price by property type \u2014 with average size when present. Fits real-estate listing / transaction exports.",requiredTypes:["property_type","sale_price"],optionalTypes:["square_feet"],instantiate(e){let t=e.property_type,o=e.sale_price,r=e.square_feet,a=r?`,
       ROUND(AVG(${n(r.column)}), 0) AS avg_square_feet`:"";return[p(`# Inventory and price brief

Listing count and average sale price by property type.`),l("inventory_by_property_type",`SELECT ${n(t.column)} AS property_type,
       COUNT(*) AS listings,
       ROUND(AVG(${n(o.column)}), 0) AS avg_sale_price${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY listings DESC
LIMIT 30`),m("bar","inventory_by_property_type","property_type","listings")]}},te={id:"education_performance",name:"Performance brief",description:"Average score and student count by course \u2014 with grade level when present. Fits school / LMS / assessment exports.",requiredTypes:["course_name","score_percent"],optionalTypes:["grade_level"],instantiate(e){let t=e.course_name,o=e.score_percent,r=e.grade_level,a=r?`,
       ${n(r.column)} AS grade_level`:"",i=r?", 3":"";return[p(`# Performance brief

Average score and student count by course.`),l("performance_by_course",`SELECT ${n(t.column)} AS course,
       COUNT(*) AS students,
       ROUND(AVG(${n(o.column)}), 1) AS avg_score${a}
FROM ${n(t.table)}
GROUP BY 1${i}
ORDER BY students DESC
LIMIT 30`),m("bar","performance_by_course","course","avg_score")]}},ne={id:"clinical_claims",name:"Clinical claims brief",description:"Encounter count and total claim amount by diagnosis \u2014 with average length of stay when present. Fits claims / EHR exports.",requiredTypes:["diagnosis_code","claim_amount"],optionalTypes:["length_of_stay"],instantiate(e){let t=e.diagnosis_code,o=e.claim_amount,r=e.length_of_stay,a=r?`,
       ROUND(AVG(${n(r.column)}), 1) AS avg_length_of_stay`:"";return[p(`# Clinical claims brief

Encounter count and total claim amount by diagnosis.`),l("claims_by_diagnosis",`SELECT ${n(t.column)} AS diagnosis,
       COUNT(*) AS encounters,
       ROUND(SUM(${n(o.column)}), 0) AS total_claim_amount${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_claim_amount DESC
LIMIT 30`),m("bar","claims_by_diagnosis","diagnosis","total_claim_amount")]}},oe={id:"demographic_summary",name:"Population and income brief",description:"Total population by region \u2014 with average median income when present. Fits census / civic / open-data aggregates.",requiredTypes:["state_region","population"],optionalTypes:["median_income"],instantiate(e){let t=e.state_region,o=e.population,r=e.median_income,a=r?`,
       ROUND(AVG(${n(r.column)}), 0) AS avg_median_income`:"";return[p(`# Population and income brief

Total population by region.`),l("population_by_region",`SELECT ${n(t.column)} AS region,
       SUM(${n(o.column)}) AS total_population${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_population DESC
LIMIT 30`),m("bar","population_by_region","region","total_population")]}},re={id:"sensor_readings",name:"Sensor readings brief",description:"Reading count and average temperature by sensor \u2014 with average humidity when present. Fits IoT / environmental / lab sensor exports.",requiredTypes:["sensor_id","temperature"],optionalTypes:["humidity"],instantiate(e){let t=e.sensor_id,o=e.temperature,r=e.humidity,a=r?`,
       ROUND(AVG(${n(r.column)}), 1) AS avg_humidity`:"";return[p(`# Sensor readings brief

Reading count and average temperature by sensor.`),l("readings_by_sensor",`SELECT ${n(t.column)} AS sensor,
       COUNT(*) AS readings,
       ROUND(AVG(${n(o.column)}), 1) AS avg_temperature${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY readings DESC
LIMIT 30`),m("bar","readings_by_sensor","sensor","avg_temperature")]}},ae={id:"fraud_review",name:"Authorization review brief",description:"Transaction count and average risk score by authorization result \u2014 with fraud rate when present. Fits fraud / payments-risk exports.",requiredTypes:["auth_result","risk_score"],optionalTypes:["fraud_flag"],instantiate(e){let t=e.auth_result,o=e.risk_score,r=e.fraud_flag,a=r?`,
       ROUND(AVG(CASE WHEN CAST(${n(r.column)} AS VARCHAR) IN ('1', 'true', 'True', 'yes') THEN 1 ELSE 0 END), 3) AS fraud_rate`:"";return[p(`# Authorization review brief

Transaction count and average risk score by authorization result.`),l("review_by_auth_result",`SELECT ${n(t.column)} AS auth_result,
       COUNT(*) AS transactions,
       ROUND(AVG(${n(o.column)}), 1) AS avg_risk_score${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY transactions DESC
LIMIT 30`),m("bar","review_by_auth_result","auth_result","transactions")]}},ie={id:"banking_flows",name:"Transaction flows brief",description:"Transaction count and total amount by debit/credit direction \u2014 with total fees when present. Fits payments / banking exports.",requiredTypes:["debit_credit","transaction_amount"],optionalTypes:["transaction_fee"],instantiate(e){let t=e.debit_credit,o=e.transaction_amount,r=e.transaction_fee,a=r?`,
       ROUND(SUM(${n(r.column)}), 0) AS total_fees`:"";return[p(`# Transaction flows brief

Transaction count and total amount by debit/credit direction.`),l("flows_by_direction",`SELECT ${n(t.column)} AS direction,
       COUNT(*) AS transactions,
       ROUND(SUM(${n(o.column)}), 0) AS total_amount${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_amount DESC
LIMIT 30`),m("bar","flows_by_direction","direction","total_amount")]}},se={id:"insurance_book",name:"Policy book brief",description:"Policy count and total premium by line of business \u2014 with total sum insured when present. Fits insurance policy / claims exports.",requiredTypes:["line_of_business","premium_amount"],optionalTypes:["sum_insured"],instantiate(e){let t=e.line_of_business,o=e.premium_amount,r=e.sum_insured,a=r?`,
       ROUND(SUM(${n(r.column)}), 0) AS total_sum_insured`:"";return[p(`# Policy book brief

Policy count and total premium by line of business.`),l("book_by_line_of_business",`SELECT ${n(t.column)} AS line_of_business,
       COUNT(*) AS policies,
       ROUND(SUM(${n(o.column)}), 0) AS total_premium${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_premium DESC
LIMIT 30`),m("bar","book_by_line_of_business","line_of_business","total_premium")]}},ce={id:"support_sla",name:"Support SLA brief",description:"Ticket count and average first-response time by priority \u2014 with average CSAT when present. Fits helpdesk / support exports.",requiredTypes:["support_priority","first_response_minutes"],optionalTypes:["csat_score"],instantiate(e){let t=e.support_priority,o=e.first_response_minutes,r=e.csat_score,a=r?`,
       ROUND(AVG(${n(r.column)}), 2) AS avg_csat`:"";return[p(`# Support SLA brief

Ticket count and average first-response time by priority.`),l("sla_by_priority",`SELECT ${n(t.column)} AS priority,
       COUNT(*) AS tickets,
       ROUND(AVG(${n(o.column)}), 1) AS avg_first_response_minutes${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY tickets DESC
LIMIT 30`),m("bar","sla_by_priority","priority","tickets")]}},le={id:"inventory_health",name:"Inventory health brief",description:"Total on-hand inventory by warehouse \u2014 with average lead time when present. Fits procurement / inventory / logistics exports.",requiredTypes:["warehouse_id","inventory_quantity"],optionalTypes:["lead_time_days"],instantiate(e){let t=e.warehouse_id,o=e.inventory_quantity,r=e.lead_time_days,a=r?`,
       ROUND(AVG(${n(r.column)}), 1) AS avg_lead_time_days`:"";return[p(`# Inventory health brief

Total on-hand inventory by warehouse.`),l("inventory_by_warehouse",`SELECT ${n(t.column)} AS warehouse,
       SUM(${n(o.column)}) AS total_inventory${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_inventory DESC
LIMIT 30`),m("bar","inventory_by_warehouse","warehouse","total_inventory")]}},ue={id:"consumption_summary",name:"Consumption brief",description:"Total kWh usage by meter \u2014 with peak kW demand when present. Fits utility metering / grid exports.",requiredTypes:["meter_id","usage_kwh"],optionalTypes:["demand_kw"],instantiate(e){let t=e.meter_id,o=e.usage_kwh,r=e.demand_kw,a=r?`,
       ROUND(MAX(${n(r.column)}), 1) AS peak_demand_kw`:"";return[p(`# Consumption brief

Total kWh usage by meter.`),l("usage_by_meter",`SELECT ${n(t.column)} AS meter,
       ROUND(SUM(${n(o.column)}), 1) AS total_usage_kwh${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_usage_kwh DESC
LIMIT 30`),m("bar","usage_by_meter","meter","total_usage_kwh")]}},de={id:"contract_pipeline",name:"Contract pipeline brief",description:"Contract count and total value by contract type \u2014 with renewal status when present. Fits legal / contract-management / GRC exports.",requiredTypes:["contract_type","contract_value"],optionalTypes:["renewal_status"],instantiate(e){let t=e.contract_type,o=e.contract_value;return[p(`# Contract pipeline brief

Contract count and total value by contract type.`),l("value_by_contract_type",`SELECT ${n(t.column)} AS contract_type,
       COUNT(*) AS contracts,
       ROUND(SUM(${n(o.column)}), 0) AS total_value
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_value DESC
LIMIT 30`),m("bar","value_by_contract_type","contract_type","total_value")]}},me={id:"production_quality",name:"Production quality brief",description:"Total produced quantity by quality result \u2014 with total defects when present. Fits manufacturing / production / QC exports.",requiredTypes:["quality_result","produced_quantity"],optionalTypes:["defect_count"],instantiate(e){let t=e.quality_result,o=e.produced_quantity,r=e.defect_count,a=r?`,
       SUM(${n(r.column)}) AS total_defects`:"";return[p(`# Production quality brief

Total produced quantity by quality result.`),l("output_by_quality_result",`SELECT ${n(t.column)} AS quality_result,
       SUM(${n(o.column)}) AS total_produced${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_produced DESC
LIMIT 30`),m("bar","output_by_quality_result","quality_result","total_produced")]}},pe={id:"metric_by_dimension",name:"Metric by category",description:"Total of a measure column grouped by a category column \u2014 a generic breakdown when no domain-specific report fits. Uses the Tier-3 role families.",requiredTypes:[],requiredRoleFamilies:["dimension","measure"],instantiate(e){let t=e.dimension,o=e.measure;return[p(`# Metric by category

Total of the measure grouped by the category.`),l("metric_by_category",`SELECT ${n(t.column)} AS category,
       COUNT(*) AS rows,
       ROUND(SUM(TRY_CAST(${n(o.column)} AS DOUBLE)), 2) AS total
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total DESC NULLS LAST
LIMIT 30`),m("bar","metric_by_category","category","total")]}},_e={id:"nonprofit_giving",name:"Giving brief",description:"Gift count and total donations by campaign \u2014 with the restricted fund when present. Fits nonprofit / fundraising / CRM exports.",requiredTypes:["campaign_name","donation_amount"],optionalTypes:["fund_name"],instantiate(e){let t=e.campaign_name,o=e.donation_amount;return[p(`# Giving brief

Gift count and total donations by campaign.`),l("giving_by_campaign",`SELECT ${n(t.column)} AS campaign,
       COUNT(*) AS gifts,
       ROUND(SUM(${n(o.column)}), 0) AS total_donations
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_donations DESC
LIMIT 30`),m("bar","giving_by_campaign","campaign","total_donations")]}},fe={id:"research_output",name:"Research output brief",description:"Paper count and total citations by venue. Fits scholarly / bibliometric exports.",requiredTypes:["venue_name","citation_count"],optionalTypes:["publication_year"],instantiate(e){let t=e.venue_name,o=e.citation_count;return[p(`# Research output brief

Paper count and total citations by venue.`),l("output_by_venue",`SELECT ${n(t.column)} AS venue,
       COUNT(*) AS papers,
       SUM(${n(o.column)}) AS total_citations
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_citations DESC
LIMIT 30`),m("bar","output_by_venue","venue","total_citations")]}},ge={id:"gov_services",name:"Public services brief",description:"Case count and total benefit by program. Fits public-service / benefits / civic exports.",requiredTypes:["program_name","benefit_amount"],optionalTypes:["application_status"],instantiate(e){let t=e.program_name,o=e.benefit_amount;return[p(`# Public services brief

Case count and total benefit by program.`),l("benefit_by_program",`SELECT ${n(t.column)} AS program,
       COUNT(*) AS cases,
       ROUND(SUM(${n(o.column)}), 0) AS total_benefit
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_benefit DESC
LIMIT 30`),m("bar","benefit_by_program","program","total_benefit")]}},be={id:"agri_yield",name:"Crop yield brief",description:"Total yield by crop type \u2014 with total acreage when present. Fits agriculture / food-systems exports.",requiredTypes:["crop_type","yield_amount"],optionalTypes:["acreage"],instantiate(e){let t=e.crop_type,o=e.yield_amount,r=e.acreage,a=r?`,
       ROUND(SUM(${n(r.column)}), 1) AS total_acreage`:"";return[p(`# Crop yield brief

Total yield by crop type.`),l("yield_by_crop",`SELECT ${n(t.column)} AS crop,
       COUNT(*) AS records,
       ROUND(SUM(${n(o.column)}), 1) AS total_yield${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_yield DESC
LIMIT 30`),m("bar","yield_by_crop","crop","total_yield")]}},ye={id:"sports_results",name:"Results brief",description:"Match count and total score by team \u2014 with total attendance when present. Fits sports / events exports.",requiredTypes:["team_name","score_for"],optionalTypes:["attendance_count"],instantiate(e){let t=e.team_name,o=e.score_for,r=e.attendance_count,a=r?`,
       SUM(${n(r.column)}) AS total_attendance`:"";return[p(`# Results brief

Match count and total score by team.`),l("results_by_team",`SELECT ${n(t.column)} AS team,
       COUNT(*) AS matches,
       SUM(${n(o.column)}) AS total_score${a}
FROM ${n(t.table)}
GROUP BY 1
ORDER BY total_score DESC
LIMIT 30`),m("bar","results_by_team","team","total_score")]}},Se={id:"finance-explorer",name:"Finance explorer",description:"Reusable totals by vendor, with payment-status and sort controls. Change a control, then Run all.",requiredTypes:["vendor_name","amount","payment_status"],measures(e){let t=e.amount;if(!t)throw new Error("Finance explorer requires an amount column.");return[{name:"finance_total",expression:`SUM(${n(t.column)})`,format:"number",description:`Total ${t.column} after row filters.`,version:1},{name:"finance_count",expression:"COUNT(*)",format:"count",description:"Invoice rows after row filters.",version:1}]},instantiate(e,t){let o=e.vendor_name,r=e.amount,a=e.payment_status;if(!o||!r||!a||o.table!==r.table||a.table!==r.table)throw new Error("Finance explorer requires same-table columns.");let i=t?.get("finance_total")??"finance_total",c=t?.get("finance_count")??"finance_count",u=(_,s,f)=>({id:"",kind:"input",name:_,label:s,inputType:"select",value:f[0]??"",defaultValue:f[0]??"",options:f}),d=`(@payment_filter = 'All' OR LOWER(TRIM(${n(a.column)})) = @payment_filter)`;return[p(`# Finance explorer

Amount column: ${r.table}.${r.column}.

Choose payment status and sorting, then **Run all**. Reset restores each control to its initial value. Saved results reflect the last run. Measures remain reusable in the Semantic model.`),u("payment_filter","Payment status",["All","paid","unpaid","pending","partial","overdue","cancelled"]),u("finance_sort","Sort vendors",["Amount descending","Amount ascending","Vendor A-Z"]),l("finance_summary",`SELECT @payment_filter AS payment_filter, MEASURE(${i}) AS total_amount, MEASURE(${c}) AS invoice_count
FROM ${n(r.table)}
WHERE ${d}`),l("finance_by_vendor",`SELECT * FROM (
SELECT ${n(o.column)} AS vendor_name, MEASURE(${i}) AS total_amount, MEASURE(${c}) AS invoice_count, @payment_filter AS payment_filter
FROM ${n(r.table)}
WHERE ${d}
GROUP BY ${n(o.column)}
) AS vendor_totals
ORDER BY CASE WHEN @finance_sort = 'Amount descending' THEN total_amount END DESC, CASE WHEN @finance_sort = 'Amount ascending' THEN total_amount END ASC, vendor_name ASC`),m("bar","finance_by_vendor","vendor_name","total_amount")]}},E=["invoice_number","order_id"];function h(e){for(let t of E){let o=e[t];if(o)return o}}var Re={id:"outstanding-explorer",name:"Outstanding by vendor",description:"Invoice total minus paid total by vendor, with one payment-status control shared by the KPI, chart, detail table, dashboard and report. Change the control, then Run all.",requiredTypes:["vendor_name","amount","payment_status"],optionalTypes:[...E],companion(e,t){let o=t.amount?.table,r=h(t);if(!o||!r)return null;let a=s=>s.toLowerCase().replace(/[^a-z0-9]/g,""),i=/total|gross|grand|payable|invoiceamount|billed/,c=(e.amount??[]).filter(s=>s.table===o&&i.test(a(s.column))).sort((s,f)=>f.score-s.score)[0]??t.amount,u=s=>(a(s.column)===a(r.column)?10:0)+(/inv|bill/.test(a(s.column))?5:0)+s.score,d=new Set;for(let s of E)for(let f of e[s]??[])f.table!==o&&d.add(f.table);let _=null;for(let s of d){let f=(e.amount??[]).filter(g=>g.table===s).sort((g,y)=>y.score-g.score)[0];if(f)for(let g of E)for(let y of(e[g]??[]).filter(b=>b.table===s)){let b=u(y)+f.score;(!_||b>_.rank)&&(_={table:s,ref:y.column,amount:f.column,rank:b})}}return!_||!c?null:{amount:{table:c.table,column:c.column},paid_invoice:{table:_.table,column:_.ref},paid_amount:{table:_.table,column:_.amount}}},measures(){return[{name:"outstanding_amount",expression:"SUM(invoice_amount) - SUM(paid_total)",format:"number",description:"Invoice total minus paid total. Reads the outstanding_base cell.",version:1},{name:"outstanding_invoice_count",expression:"COUNT(*)",format:"count",description:"Invoices after the shared payment-status filter.",version:1}]},instantiate(e,t){let o=e.vendor_name,r=e.amount,a=e.payment_status,i=h(e),c=e.paid_invoice,u=e.paid_amount;if(!o||!r||!a||!i||!c||!u||o.table!==r.table||a.table!==r.table||i.table!==r.table)throw new Error("Outstanding by vendor requires invoice columns and a payments table.");let d=t?.get("outstanding_amount")??"outstanding_amount",_=t?.get("outstanding_invoice_count")??"outstanding_invoice_count",s=(b,S,R)=>({id:"",kind:"input",name:b,label:S,inputType:"select",value:R[0]??"",defaultValue:R[0]??"",options:R}),f="(@payment_filter = 'All' OR LOWER(TRIM(payment_status)) = @payment_filter)",g=`WITH paid AS (
  SELECT TRIM(CAST(${n(c.column)} AS VARCHAR)) AS invoice_ref,
         SUM(CAST(${n(u.column)} AS DECIMAL(18,2))) AS paid_total
  FROM ${n(u.table)}
  GROUP BY 1
)
SELECT TRIM(CAST(i.${n(i.column)} AS VARCHAR)) AS invoice_ref,
       i.${n(o.column)} AS vendor_name,
       i.${n(a.column)} AS payment_status,
       CAST(i.${n(r.column)} AS DECIMAL(18,2)) AS invoice_amount,
       COALESCE(paid.paid_total, CAST(0 AS DECIMAL(18,2))) AS paid_total
FROM ${n(r.table)} AS i
LEFT JOIN paid ON paid.invoice_ref = TRIM(CAST(i.${n(i.column)} AS VARCHAR))`,y={...p(`## Methodology

Outstanding Amount is the invoice total minus the paid total. Payments are summed per invoice before they are joined, so an invoice paid in instalments counts once. The payment-status control filters invoice rows before any total is calculated; a blank status appears only under All. Pick a status, press **Run all**, then Refresh data in the report before printing.`),name:"outstanding_note"};return[p(`# Outstanding by vendor

Invoices: ${r.table}.${r.column}. Payments: ${u.table}.${u.column}.

Choose payment status and sorting, then **Run all**. Results stay on screen until you run them again. Reset restores each control to its initial value.`),s("payment_filter","Payment status",["All","paid","unpaid","pending","partial","overdue","cancelled"]),s("outstanding_sort","Sort vendors",["Amount descending","Amount ascending","Vendor A-Z"]),l("outstanding_base",g),l("outstanding_summary",`SELECT @payment_filter AS payment_filter, MEASURE(${d}) AS total_outstanding, MEASURE(${_}) AS invoice_count
FROM @outstanding_base
WHERE ${f}`),l("outstanding_by_vendor",`SELECT * FROM (
SELECT vendor_name, MEASURE(${d}) AS outstanding_amount, MEASURE(${_}) AS invoice_count, @payment_filter AS payment_filter
FROM @outstanding_base
WHERE ${f}
GROUP BY vendor_name
) AS vendor_outstanding
ORDER BY CASE WHEN @outstanding_sort = 'Amount descending' THEN outstanding_amount END DESC, CASE WHEN @outstanding_sort = 'Amount ascending' THEN outstanding_amount END ASC, vendor_name ASC`),{...m("bar","outstanding_by_vendor","vendor_name","outstanding_amount"),name:"outstanding_chart"},l("outstanding_detail",`SELECT invoice_ref, vendor_name, payment_status, invoice_amount, paid_total, invoice_amount - paid_total AS outstanding_amount, @payment_filter AS payment_filter
FROM @outstanding_base
WHERE ${f}
ORDER BY outstanding_amount DESC, invoice_ref ASC`),y,{id:"",kind:"dashboard",name:"outstanding_dashboard",columns:2,items:["payment_filter","outstanding_sort","outstanding_summary","outstanding_chart","outstanding_detail"]},{id:"",kind:"report",name:"outstanding_report",definition:{title:"Outstanding by vendor",pageSize:"A4",margins:T,subtitle:"Outstanding Amount = invoice total minus paid total",items:[{kind:"kpi-row",tiles:[{measure:d,label:"Total outstanding"}],sourceCell:"outstanding_summary",valueColumn:"total_outstanding"},{kind:"cell-ref",cellName:"outstanding_note"},{kind:"cell-ref",cellName:"outstanding_chart"},{kind:"cell-ref",cellName:"outstanding_detail"}]}}]}},Te=[Se,Re,w,B,L,x,P,Y,q,G,V,W,H,K,z,j,J,Q,X,Z,ee,te,ne,oe,re,ae,ie,se,ce,le,ue,me,de,_e,fe,ge,be,ye,pe],Ae=[{id:"briefing_memo",name:"Briefing memo",title:"Executive briefing",sections:[{suffix:"summary",body:`## Summary

_One-paragraph TL;DR: what this covers and the single most important takeaway._`},{suffix:"findings",body:`## Key findings

- 
- 
- `},{suffix:"recommendation",body:`## Recommendation

_What should happen next, and why._`}]},{id:"operating_review",name:"Operating review",title:"Operating review",sections:[{suffix:"period",body:`## Period summary

_Reporting period and the headline movement vs. the prior period._`},{suffix:"metrics",body:`## Metrics

_Add a KPI row or chart cell, then reference it here and call out the drivers._`},{suffix:"segments",body:`## By segment

_Where performance concentrated \u2014 the top and bottom segments._`,pageBreakBefore:!0},{suffix:"actions",body:`## Risks & actions

- Risk: 
- Action: `}]},{id:"dataset_audit",name:"Dataset audit",title:"Dataset audit",sections:[{suffix:"overview",body:`## Overview

_What this dataset is, its source, and the period it covers._`},{suffix:"schema",body:`## Schema & coverage

_Columns, semantic types, row count, and null / coverage notes._`},{suffix:"quality",body:`## Quality notes

- 
- `},{suffix:"provenance",body:`## Provenance

_Where the data came from, how it was mounted, and any transforms applied._`}]}];function Ee(e,t,o){let r=Ae.find(c=>c.id===e);if(!r)return null;let a=r.sections.map(c=>({name:`${t}_${c.suffix}`,code:c.body})),i=[];for(let c of r.sections)c.pageBreakBefore&&i.push({kind:"page-break"}),i.push({kind:"cell-ref",cellName:`${t}_${c.suffix}`});return{markdownCells:a,definition:{title:r.title,pageSize:"A4",margins:T,subtitle:`Prepared ${o}`,items:i}}}function Ce(e){let t=e.replace(/[_\s]+/g," ").trim().split(" ").filter(Boolean);return t.length===0?"Report":t.map((o,r)=>r===0?o.charAt(0).toUpperCase()+o.slice(1):o).join(" ")}function Oe(e){let t=e.sqlName?.trim()||"",o=t||`result_${e.cellId}`,r=`${o}_notes`,a=e.chart?`${o}_chart`:null,i=t?Ce(t):"Report",c=`${e.rowCount.toLocaleString()} row${e.rowCount===1?"":"s"}`,u=e.sqlCode.trim(),d=e.sourcesBlock?.trim()?[e.sourcesBlock.trim(),""]:[],_=[`**${c}** \xB7 generated ${e.today}`,"","**Query**","","```sql",u,"```","",...d,"### Key notes","","_Add your notes here._"].join(`
`),s=e.kpis?[{kind:"kpi-row",tiles:e.kpis.tiles,sourceCell:o,valueColumn:e.kpis.valueColumn}]:[],f={...O(),title:i,subtitle:`${c} \xB7 ${e.today}`,items:[...s,{kind:"cell-ref",cellName:r},{kind:"cell-ref",cellName:o},...a?[{kind:"cell-ref",cellName:a}]:[]]};return{sqlName:o,notesName:r,notesMarkdown:_,chartName:a,definition:f}}function v(e){if(e==null)return null;if(typeof e=="number")return Number.isFinite(e)?e:null;if(typeof e=="bigint")return Number(e);if(typeof e=="boolean")return null;if(typeof e=="string"){let t=e.trim();if(t==="")return null;let o=Number(t);return Number.isFinite(o)?o:null}return typeof e=="object"?he(e):null}function he(e){let t=Object.keys(e).length;if(t===0)return null;let o=[];for(let i=0;i<t;i++){let c=e[String(i)];if(typeof c!="number"||!Number.isInteger(c)||c<0||c>4294967295)return null;o.push(BigInt(c))}let r=0n;for(let i=t-1;i>=0;i--)r=r<<32n|o[i];let a=BigInt(t*32);return r&1n<<a-1n&&(r-=1n<<a),Number(r)}function ve(e){return`"${e.replace(/"/g,'""')}"`}function $e(e){return e.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").replace(/^([0-9])/,"_$1").slice(0,48).replace(/_+$/g,"")||"result"}function Me(e,t){let o=ve(t),r=[{name:`${e}_total`,expression:`SUM(${o})`,format:"number",description:`Total of ${t}.`,version:1},{name:`${e}_average`,expression:`AVG(${o})`,format:"number",description:`Average of ${t}.`,version:1},{name:`${e}_count`,expression:"COUNT(*)",format:"count",description:"Number of rows in the result.",version:1}],a=[{measure:`${e}_total`,label:"Total",format:"number"},{measure:`${e}_average`,label:"Average",format:"number"},{measure:`${e}_count`,label:"Rows",format:"count"}];return{measures:r,bindings:a}}function Ne(e,t){let o=0,r=0;for(let a of e){let i=v(a[t]);i!==null&&(o+=i,r++)}return{total:o,average:r>0?o/r:null,count:e.length}}function $(e,t){if(e===null||!Number.isFinite(e))return"\u2014";switch(t){case"count":return Math.round(e).toLocaleString();case"percent":return`${(e*100).toLocaleString(void 0,{maximumFractionDigits:1})}%`;case"currency_inr":return`\u20B9${e.toLocaleString(void 0,{maximumFractionDigits:2})}`;case"currency_usd":return`$${e.toLocaleString(void 0,{maximumFractionDigits:2})}`;case"currency_eur":return`\u20AC${e.toLocaleString(void 0,{maximumFractionDigits:2})}`;default:return Number.isInteger(e)?e.toLocaleString():e.toLocaleString(void 0,{maximumFractionDigits:2})}}function M(e,t){return/^total\b/i.test(e)?t.total:/^average\b/i.test(e)?t.average:t.count}function Ue(e,t){return e.slice(0,4).map(o=>({measure:o.measure,label:o.label,value:$(M(o.label,t),o.format)}))}function De(e,t,o){return e.map(r=>({measure:r.measure,label:r.label,value:$(M(r.label,t),o(r.measure))}))}export{Te as ALL_TEMPLATES,Ee as buildExecutiveReport,Ue as buildKpiTiles,Oe as buildReportScaffold,Ne as computeKpiValues,Me as deriveResultMeasures,D as findApplicableTemplates,k as indexByTypeWithCandidates,De as recomputeKpiTiles,$e as sanitizeMeasureBase};
