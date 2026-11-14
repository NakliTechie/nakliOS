# Taxonomy migrations

One line per change to an existing type's detectors, `sql_compat`,
`confidence_floor`, crosswalk entry, or id. Format:
`YYYY-MM-DD · <type id> · <what changed> · <what a saved workbook may see differently>`

- 2026-09-22 · yes_no_flag · numeric SQL compatibility and descriptor/keywords added; numeric 0/1 alone remains review-only · numeric flag columns may now show a yes/no suggestion on re-classify, while existing assignments stay saved

- 2026-09-12 · (edition) · first dated edition; `created` set on all 236 types; no detector changed · nothing
- 2026-09-12 · country_name · header aliases +['native_country', 'birth_country', 'country_of_birth'] · a saved workbook whose native.country column was unknown classifies as country_name on re-classify
- 2026-09-12 · tariff_code · header aliases +['ratecode', 'rate_code', 'ratecodeid', 'rate_code_id', 'fare_code']; sql_compat +['INTEGER', 'BIGINT', 'SMALLINT'] · RatecodeID-style columns classify as tariff_code; numeric codes now allowed
- 2026-09-12 · employment_status · header aliases +['attrition', 'attrition_num', 'attrition_flag', 'left_company', 'has_left'] · attrition columns classify as employment_status
- 2026-09-12 · job_title · sql_compat +['INTEGER', 'BIGINT', 'SMALLINT'] · encoded job-role columns (JobRole_Num) classify as job_title
- 2026-09-12 · department · sql_compat +['INTEGER', 'BIGINT', 'SMALLINT'] · encoded department columns (Department_Num) classify as department
- 2026-09-12 · employee_engagement_score · header aliases +['job_involvement', 'jobinvolvement', 'involvement_score'] · JobInvolvement survey scores classify as employee_engagement_score
- 2026-09-12 · (edition) · 9 types added for the P1 tail: available_capacity, employment_sector, survey_weight, household_relationship, income_band, vendor_id, yes_no_flag, travel_frequency, job_level · previously-unknown columns classify on re-classify
- 2026-09-12 · (detectors) · value_set comparison is now separator-insensitive (`United-States` ≡ `United States`) · enumerated columns written with hyphens or underscores now match their value sets
- 2026-09-12 · tds_section · regex accepts the hyphenated section form (194-IA, 194-IB) · columns written with a hyphen now match
- 2026-09-12 · (review) · the 19 agent_v1.0 seed types passed a format review (docs/seed-review-2026-09-12.md); review: pending cleared, seed_origin kept as provenance · nothing
- 2026-09-12 · ip_v6 · regex now accepts every RFC 4291 text form (`::` compression anywhere, `::ffff:a.b.c.d`) · compressed IPv6 columns now classify
