# Contabo (Cloud VPS, Cloud VPS Plus, Cloud VDS) as a single-node k3s host — as of October 2026

Context: a single-node k3s cluster running 3–8 coding-agent pods. Each pod requests 1 CPU/2GiB or 2 CPU/4GiB and has a 20Gi volume. The pods clone repos, run Claude Code, and do occasional CPU-heavy npm installs and native compiles. The user is probably in the US.

Research was done 2026-10-15. Prices are in EUR unless noted. Contabo shows prices per visitor locale and VAT. €4.40 on the US-facing page and €5.24 "incl. VAT" on Contabo's blog differ by exactly the German 19% VAT (4.40 × 1.19 = 5.24, and 10.80 × 1.19 = 12.85). So the en-us figures below are best read as ex-VAT, which is what a US buyer pays. That is my inference, not something Contabo states.

## 1. Current plan lineup and prices (Cloud VPS, Cloud VPS Plus, Cloud VDS)

### Takeaway
Contabo changed its lineup in 2026. It now has three lines: "Core" Cloud VPS 4/6/8/12/16/18 (shared vCPU, SSD with an NVMe option), "Performance" Cloud VPS Plus 4–18 (shared AMD EPYC vCPU, more NVMe), and Cloud VDS S–XXL (dedicated AMD EPYC 7282 cores). Every plan is month-to-month with no setup fee. A 12-month term saves 15% and a 24-month term saves 20%. One IPv4 is included. US locations add a small surcharge, which third parties put at about €1.3–1.9/mo.

### Cited Findings
**Cloud VPS (Core), from Contabo's en-us VPS page (fetched 2026-10-15).** The headline price is the 24-month effective monthly rate. The second figure is the undiscounted monthly price. [Contabo VPS](https://contabo.com/en-us/vps/)

| Plan | vCPU | RAM | Disk | Port | 24-mo €/mo | Monthly €/mo |
|---|---|---|---|---|---|---|
| Cloud VPS 4 | 4 | 8 GB | 100 GB SSD | 200 Mbit/s | 4.40 | 5.50 |
| Cloud VPS 6 | 6 | 12 GB | 200 GB SSD or 100 GB NVMe | 300 Mbit/s | 6.00 | 7.50 |
| Cloud VPS 8 | 8 | 24 GB | 300 GB SSD or 150 GB NVMe | 600 Mbit/s | 11.20 | 14.00 |
| Cloud VPS 12 | 12 | 48 GB | 400 GB SSD or 200 GB NVMe | 800 Mbit/s | 20.00 | 25.00 |
| Cloud VPS 16 | 16 | 64 GB | 500 GB SSD or 250 GB NVMe | 1 Gbit/s | 29.60 | 37.00 |
| Cloud VPS 18 | 18 | 96 GB | 600 GB SSD or 300 GB NVMe | 1 Gbit/s | 39.20 | 49.00 |

- Snapshots included: 1 on VPS 4, 2 on VPS 6, 3 on VPS 8 and up. Traffic is "Unlimited*" under a fair-usage policy, and Contabo "may throttle servers with exceptionally high or disruptive usage." Every plan includes dedicated IPv4 and IPv6. — [Contabo VPS](https://contabo.com/en-us/vps/)
- **Term pricing (configurator, Cloud VPS 12):** 1, 3 and 6 months all cost €25.00/mo. 12 months costs €21.25/mo (-15%) and 24 months €20.00/mo (-20%). The configurator showed no setup fee on any term. — [Contabo configurator](https://contabo.com/en-us/vps/cloud-vps-4/?addons=1&image=ubuntu.332&qty=1&contract=1&storage-type=vps-4-100-gb-ssd). The Cloud VDS FAQ gives the same 15% and 20% discounts and says there is no setup fee "including on 1-month and 6-month terms." — [Contabo VDS](https://contabo.com/en-us/vds/)
- vpsbenchmarks lists Cloud VPS 18 at €49.00/mo, or €41.65/mo on a 1-year term. That matches the 15% discount. — [vpsbenchmarks Cloud VPS 18](https://www.vpsbenchmarks.com/hosters/contabo/plans/cloud-vps-18)
- **Contract/API terms:** API instance creation accepts contract periods of 1, 12 or 24 months. — [Contabo API](https://api.contabo.com/). The T&Cs list initial terms of 1, 3, 6 or 12 months, which auto-extend unless cancelled 4 weeks before the term ends (clause 5(1)). — [Contabo T&C](https://contabo.com/en/legal/terms-and-conditions/). The VPS page says prepaid plans need no notice and postpaid plans need 4 weeks. — [Contabo VPS](https://contabo.com/en-us/vps/)

**Cloud VPS Plus ("Performance VPS"), 24-month €/mo, from Contabo's pricing page:**

| Plan | Price |
|---|---|
| Plus 4 | 10.80 |
| Plus 6 | 15.20 |
| Plus 8 | 28.00 |
| Plus 12 | 47.20 |
| Plus 16 | 63.20 |
| Plus 18 | 79.20 |

Source: [Contabo pricing](https://contabo.com/en-us/pricing/).
- HostingCompass (checked 2026-10-11) gives the Plus disk sizes: Plus 4 (4 vCPU/8 GB) 150 GB, Plus 6 300 GB, Plus 8 (8/24) 450 GB, Plus 12 (12/48) 600 GB, Plus 16 (16/64) 750 GB, Plus 18 (18/96) 900 GB. — [HostingCompass](https://hostingcompass.com/en/providers/contabo/vps)
- Contabo's blog describes Plus 4 as "4 vCPU AMD EPYC, 8 GB RAM, 150 GB NVMe," at €12.85/mo on 24 months incl. VAT (verified 2026-08-17). It calls the Plus line "High-Performance AI-Ready Virtual Private Servers." — [Contabo blog](https://contabo.com/blog/best-budget-vps-developers/)
- Plus 4 and Plus 6 have 500 Mbit/s ports, and the larger Plus plans have 1 Gbit/s. vpsbenchmarks classifies Plus as **shared CPU**. — [vpsbenchmarks Plus 8](https://www.vpsbenchmarks.com/hosters/contabo/plans/cloud-vps-plus-8). vpsbenchmarks lists Plus 4 at €13.50/mo, which is the monthly list price. — [vpsbenchmarks compare](https://www.vpsbenchmarks.com/compare/contabo)

**Cloud VDS, from Contabo's en-us VDS page.** All plans use AMD EPYC 7282 at 2.8 GHz with cores "dedicated" to the instance. [Contabo VDS](https://contabo.com/en-us/vds/)

| Plan | vCores | RAM | NVMe | Port | 24-mo €/mo | List €/mo |
|---|---|---|---|---|---|---|
| VDS S | 6 | 24 GB | 180 GB | 250 Mbit/s | 39.20 | 49.00 |
| VDS M | 8 | 32 GB | 240 GB | 500 Mbit/s | 49.60 | 62.00 |
| VDS L | 12 | 48 GB | 360 GB | 750 Mbit/s | 69.60 | 87.00 |
| VDS XL | 16 | 64 GB | 480 GB | 1 Gbit/s | 94.40 | 118.00 |
| VDS XXL | 24 | 96 GB | 720 GB | 1 Gbit/s | 139.20 | 174.00 |

- An older, now-deprecated "VDS S NVMe" listing on vpsbenchmarks shows **3 cores**, 24 GB and 180 GB at €42.99/mo. — [vpsbenchmarks VDS S NVMe](https://vpsbenchmarks.com/hosters/contabo/plans/vds-s-nvme)

**US location surcharge**
- Contabo's configurator showed region groups (Europe/America/Asia/Australia) but no surcharge figure in the fetched text. — [Contabo configurator](https://contabo.com/en-us/vps/cloud-vps-4/?addons=1&image=ubuntu.332&qty=1&contract=1&storage-type=vps-4-100-gb-ssd)
- HostingCompass says only "Location surcharges extra." — [HostingCompass](https://hostingcompass.com/en/providers/contabo/vps)
- A September 2026 third-party review gives "+€1.26 to +€1.86/mo" for the US region on Cloud VPS 4. It does not name the site (St. Louis, NYC or Seattle). — via search summary of [affinco](https://affinco.com/contabo-pricing/) and [toolradar](https://toolradar.com/tools/contabo/pricing)
- The 2020 US launch charged per-plan location fees from +€1 (VPS S) to +€6 (VPS XL). That data is about six years old. — [LowEndSpirit 2020](https://lowendspirit.com/discussion/865/teaser-contabo-big-announcement-tomorrow-april-6th)

**Add-ons (configurator, Cloud VPS 12, EU)**

| Add-on | Price |
|---|---|
| Private Networking | €2.29/mo |
| Auto Backup (daily, keeps last 10 versions) | €6.70/mo |
| Extra IPv4 | €3.50/mo (1 IPv4 included) |
| Extra SSD (800 GB instead of 400 GB) | €6.00/mo |
| Object Storage (EU) | €2.49 per 250 GB per month, up to 1 TB for €9.96 |
| Full Monitoring | €11.49/mo |

Source: [Contabo configurator](https://contabo.com/en-us/vps/cloud-vps-4/?addons=1&image=ubuntu.332&qty=1&contract=1&storage-type=vps-4-100-gb-ssd)
- One third party says Auto Backup costs "under $1/mo" (Feb 2025 launch) and object storage $2.99 per 250 GB. This conflicts with the €6.70 above. Backup pricing probably scales with plan size. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)

**2026 price and lineup changes**
- learnwithhasan logged a change on 2026-08-03: the entry price rose from €3.60 to €4.50/mo. That site still lists the old "Cloud VPS 10" (4 vCPU/8 GB/75 GB NVMe/32 TB) lineup, so it is internally inconsistent. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- As of Sept–Oct 2026, Contabo's own pages show Cloud VPS 4–18 and Plus 4–18. vpsbenchmarks tested "Cloud VPS 10" in Dec 2025 and "Cloud VPS 18" in Sep 2026. So the rename from VPS 10/20/… to VPS 4/6/… happened during 2026. — [vpsbenchmarks endurance Dec 2025](https://www.vpsbenchmarks.com/trials/contabo_performance_trial_12Dec2025/endurance_runs/last); [Contabo VPS](https://contabo.com/en-us/vps/)
- Cybernews reports a 20% back-to-school/student promo for 2026, with Cloud VPS 4 at $5.28/mo. — [Cybernews](https://cybernews.com/deals/contabo-vps-back-to-school-student-deal-2026-save-20-on-contabo-vps-sale/)

### Inferences
- **Sizing for 8 pods at 2 CPU/4 GiB (16 vCPU/32 GiB requested):** on paper, Cloud VPS 16 (16 vCPU/64 GB) fits at about €29.60/mo on 24 months or €37/mo month-to-month, plus the US surcharge.
- **Sizing for 3–8 pods at 1 CPU/2 GiB:** Cloud VPS 8 (8 vCPU/24 GB, about €11–14) fits on paper.
- **Dedicated alternatives:** VDS M (8 cores/32 GB) costs €49.60–62, and VDS XL (16 cores/64 GB) costs €94–118.
- **Disk:** each pod has a 20Gi PVC, so 8 pods need 160 GB plus images and the OS. That means taking the SSD option on VPS 12/16, choosing a Plus plan for NVMe, or adding the €6 extra SSD.
- **Price in USD:** it is unclear whether a US account priced in USD sees the same numbers. Contabo lets you pick EUR, USD or GBP at signup and fixes the account to that currency. — [Contabo VPS](https://contabo.com/en-us/vps/)

### Gaps
- I could not get an exact current US surcharge for St. Louis, New York or Seattle from Contabo's own page.
- I could not confirm USD pricing.
- I could not confirm whether the en-us figures exclude VAT. The 19% ratio is my inference.

## 2. CPU oversubscription, benchmarks, disk and network; VPS vs VDS

### Takeaway
Cloud VPS vCPUs are heavily shared. In a September 2026 YABS on an 18-vCPU Cloud VPS 18, Geekbench 6 multi-core scored only 2,971, roughly the throughput of a few dedicated cores, and vpsbenchmarks graded its stability F. Steal varies by node: some long-running VPSes see 0%, others 60–80%. VDS gives dedicated, stable but older EPYC 7282 (Zen 2) cores with modest single-thread speed.

### Cited Findings
**Cloud VPS 18 YABS (2026-09-08, Lauterbourg, France)**
- **CPU:** "AMD EPYC Processor (with IBPB)," 18 cores at 2,496 MHz on KVM. VM-x/AMD-V is disabled, so there is no nested virtualization. The host ran Ubuntu 26.04.1 with kernel 7.0.0. — [vpsbenchmarks YABS](https://www.vpsbenchmarks.com/yabs/contabo-18c-94gb-20260908-tg10813)
- **Geekbench:** GB6 991 single-core / 2,971 multi-core. GB7 969 / 4,020. — [vpsbenchmarks YABS](https://www.vpsbenchmarks.com/yabs/contabo-18c-94gb-20260908-tg10813)
- **fio, mixed 50/50:**

| Block size | Total throughput | Total IOPS |
|---|---|---|
| 4k | 127.8 MB/s | about 32k |
| 64k | 836 MB/s | — |
| 1m | 1,147 MB/s | — |

  Source: [vpsbenchmarks YABS](https://www.vpsbenchmarks.com/yabs/contabo-18c-94gb-20260908-tg10813)
- **iperf3, send/recv:**

| Target | Send | Recv |
|---|---|---|
| Amsterdam | 666 Mbit/s | 816 Mbit/s |
| NYC | 668 Mbit/s | 373 Mbit/s |
| Los Angeles | 499 Mbit/s | 73.5 Mbit/s |

  Source: [vpsbenchmarks YABS](https://www.vpsbenchmarks.com/yabs/contabo-18c-94gb-20260908-tg10813)
- **Grades for that trial:**

| Category | Grade | Score |
|---|---|---|
| Web | E | 3.71 |
| Raw CPU | B | 14.72 |
| Performance Stability | F | 0.82 |
| Disk IO | E | 4.92 |
| Network | D | 7.11 |
| Overall (price-weighted) | — | 31 |

  Shared CPU: yes. Provisioning took about 1 minute. — [vpsbenchmarks trial](https://www.vpsbenchmarks.com/trials/contabo_performance_trial_08Sep2026)

**Cloud VPS Plus 4 (trial 2026-07-27)**
- Grades: Web B (16.6), Raw CPU B (15.1), Stability C (12.4), Disk D (6.9), Network D (7.0). — [vpsbenchmarks compare](https://www.vpsbenchmarks.com/compare/contabo)

**Cloud VDS**
- **VDS S (trial 2026-10-08):** Web C (10.6), CPU C (10.5), Stability B (14.3), Disk C (11.2), Network E (5.4). — [vpsbenchmarks compare](https://www.vpsbenchmarks.com/compare/contabo)
- **VDS S NVMe (deprecated 3-core listing, trial 2026-01-26, Nuremberg):**
  - CPU: AMD EPYC 7282, dedicated (not shared). Raw CPU C (10.77), Stability B (15.21).
  - The site badges it "very stable over long periods." It delivers its advertised 250 Mbps. Overall score 55.
  - Earlier trials (2023–2024) were all graded C.
  - Source: [vpsbenchmarks VDS S NVMe](https://vpsbenchmarks.com/hosters/contabo/plans/vds-s-nvme)

**Provider-wide**
- Contabo's consistency score on vpsbenchmarks is 56. The site says above 65 means high consistency. — [vpsbenchmarks compare](https://www.vpsbenchmarks.com/compare/contabo)
- CPUs seen across Contabo instances in the last 18 months: EPYC 7282 and generic "AMD EPYC (with IBPB)." Average provisioning across 3 creations was 60 seconds. — [vpsbenchmarks compare](https://www.vpsbenchmarks.com/compare/contabo)

**Steal and endurance**
- **Cloud VPS 10 endurance (24 h at 50% CPU, Dec 12–13, 2025):** steal was 0.00% every hour, with no throttling trend. Throughput had a coefficient of variation of 11.26%, with hourly iterations ranging from 6,485 to 9,310. — [vpsbenchmarks endurance](https://www.vpsbenchmarks.com/trials/contabo_performance_trial_12Dec2025/endurance_runs/last)
- **LowEndTalk anecdotes (2021–2025):**
  - Users report 60–80% steal on some nodes. A 2024 user saw a new VPS at about 80% steal "consistently." One user faced "10MB/s disk I/O and 75% CPU steal."
  - Node migration sometimes fixed it, but in one case steal returned within a week.
  - Other users run under 5% steal for over a year.
  - Sources: search summary of [LET "is contabo good?"](https://lowendtalk.com/discussion/206685/is-contabo-good), [LET "Contabo limits my VPS performance"](https://lowendtalk.com/discussion/199583/contabo-limits-my-vps-performance) (403 on direct fetch), and [LET CPU usage limitations](https://lowendtalk.com/discussion/172063/question-on-contabo-cpu-usage-limitations)
- **Disk on contended nodes:** a third-party summary says NVMe IOPS are "about a quarter of a comparable SATA datacenter SSD," with peak sequential NVMe at about 300–500 MB/s. This is secondhand. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)

### Inferences
- GB6 multi-core of about 3,000 across 18 vCPUs suggests each vCPU delivers a small fraction of a real core under contention. A dedicated modern 4-core usually scores well above that.
- For bursty npm installs and native compiles, Cloud VPS 16/18 will probably feel like a few cores, not 16. Kubernetes CPU requests/limits would be fiction against real capacity. Throughput will vary by node and time of day.
- VDS gives predictable cores, but they are Zen 2 (2019 era) with mediocre single-thread speed.
- Plus beat both Core and VDS S on the Raw CPU grade in 2026 tests. It is still shared, though, and only one or a few trials exist.
- The recurring community advice is "benchmark on arrival, run `top`, watch %st, and ask for a node move or cancel within the 14-day window."

### Gaps
- vpsbenchmarks pages exposed no raw sysbench numbers or US-location trials for 2026. Every 2026 Contabo trial I found was in Germany or France.
- I found no 2026-dated Reddit or LowEndTalk steal reports.
- I found no Geekbench numbers for Plus or VDS in 2026.

## 3. Network: traffic limits, port speed, fair use

### Takeaway
Traffic is advertised as "Unlimited*" under fair use. Port speed scales by plan: 200 Mbit/s on Cloud VPS 4 up to 1 Gbit/s on VPS 16/18. VDS ports run from 250 Mbit/s on S to 1 Gbit/s on XL/XXL. The T&Cs do not guarantee bandwidth.

### Cited Findings
- **Port speeds:**

| Plan | Port |
|---|---|
| Cloud VPS 4 | 200 Mbit/s |
| Cloud VPS 6 | 300 Mbit/s |
| Cloud VPS 8 | 600 Mbit/s |
| Cloud VPS 12 | 800 Mbit/s |
| Cloud VPS 16 and 18 | 1 Gbit/s |

  Traffic is "Unlimited*" under fair use, and Contabo "may throttle servers with exceptionally high or disruptive usage." — [Contabo VPS](https://contabo.com/en-us/vps/)
- **VDS traffic:** incoming is unlimited and unmetered. Outgoing is unlimited under fair use. — [Contabo VDS](https://contabo.com/en-us/vds/)
- **T&C clause 11(2):** the provider "cannot guarantee the level/volume of the bandwidth that will actually be available." — [Contabo T&C](https://contabo.com/en/legal/terms-and-conditions/)
- **Older lineup:** Cloud VPS 10 was listed with 32 TB of transfer, which suggests an earlier metered cap. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Measured transfer-in (EU → US):** iperf receive rates were low on the Sep 2026 Cloud VPS 18: LA 73.5 Mbit/s and NYC 373 Mbit/s. — [vpsbenchmarks YABS](https://www.vpsbenchmarks.com/yabs/contabo-18c-94gb-20260908-tg10813)
- **Port 25:** open by default, with a practical limit of about 25 emails per minute. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)

### Inferences
- Git clones and npm or registry pulls are small relative to these limits, so traffic is not a concern for this workload.
- Ingress throughput into a US location is untested. The EU numbers above only cover the cross-Atlantic path.

### Gaps
- I found no recent US-datacenter iperf data.

## 4. Reliability and support reputation, 2025–2026

### Takeaway
Contabo is cheap and widely used but has a mixed reputation. Support is ticket-only and slow (hours to days). Some customers report abuse suspensions on recycled IPs. In 2026 the US Central (St. Louis) site had a network issue and APAC object storage was degraded.

### Cited Findings
- **Contabo status page:** reported a network connectivity issue at the **US Central** datacenter on 2026-10-09, later resolved. A degraded APAC Object Storage CEPH cluster ran from 2026-09-08. It was attributed to a broken Australia–Singapore submarine cable, with repair expected in November and automated backups paused (for APAC). This comes from a search summary of [contabo-status.com](https://contabo-status.com/) and [StatusGator](https://statusgator.com/services/contabo). The summary also mentioned a 2026-10-15 host-patching notice with an implausible CVE ID, which I treated as unreliable and did not verify.
- **User-reported outage:** a "network" outage of "12 hours at least" on 2026-02-23. Not confirmed by Contabo. — [Pingoru](https://pingoru.io/providers/contabo)
- **Older incident:** a 2024 server outage caused by cooling problems. — [heise](https://www.heise.de/en/news/Web-host-Contabo-Server-outage-due-to-cooling-problems-9855587.html)
- **Support (verified 2026-04-26 by a third party):**
  - Channels are ticket, email and an AI chatbot. There is no live chat or phone.
  - Typical replies take 2–12 h. Complex or weekend issues take 24–72 h.
  - Trustpilot rose from 3.5 in 2024 to 4.4 in 2025–26 (about 172k reviews).
  - Source: [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Abuse suspensions:** reported on recycled IPs, "sometimes within hours of provisioning," with a reactivation fee of about €30. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Uptime:** 99.9% network uptime SLA, and about 99.97% measured over 30 days in Germany. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Account verification (T&C):**
  - Clause 3(4): Contabo may demand "special evidence/important data" when it doubts a customer's identity.
  - Clause 3(6): ongoing sanctions-list screening.
  - Clause 4(12): reactivation after non-payment suspension may incur a fee.
  - Source: [Contabo T&C](https://contabo.com/en/legal/terms-and-conditions/)
- **Refunds and renewals:** 14-day refund window, auto-renewals refundable for 72 h, and long commitments run their full term. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Provisioning:** about 1 minute in vpsbenchmarks trials. — [vpsbenchmarks trial](https://www.vpsbenchmarks.com/trials/contabo_performance_trial_08Sep2026)
- **Community consensus:** use Contabo for dev/staging, side projects and bulk capacity. Move SLA-bound production elsewhere. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/); [LET](https://lowendtalk.com/discussion/206685/is-contabo-good)

### Inferences
- A US Central network blip in October 2026 matters if the user picks St. Louis.
- Slow support means a bad node (high steal) could take days to fix. The practical fix is to provision a new VPS and cancel within 14 days.

### Gaps
- learnwithhasan is a third-party aggregator with internal inconsistencies, so its support and Trustpilot figures are secondhand.
- I could not fetch Contabo's status history directly.
- I found no concrete 2026 data on how often new-account fraud checks or manual verification hold up provisioning.

## 5. Kubernetes/k3s friendliness

### Takeaway
k3s-friendly enough. Plans are full KVM VMs with a stock Ubuntu kernel (7.0 seen in Sep 2026), cloud-init, snapshots, custom images (qcow2/iso), a firewall API, a Terraform provider and S3 object storage. There is no managed Kubernetes, no nested virtualization, and no attachable block volumes. PVCs live on the local disk, for example through k3s local-path.

### Cited Findings
- **Virtualization:** KVM, with AMD-V/VM-x not exposed to the guest. Ubuntu 26.04.1 ran kernel 7.0.0-30-generic. — [vpsbenchmarks YABS](https://www.vpsbenchmarks.com/yabs/contabo-18c-94gb-20260908-tg10813)
- **API:**
  - Instances: create, reinstall, start/stop/rescue, snapshots (create, revert, delete).
  - Custom images in `.qcow2` or `.iso`. cloud-init via `user_data` works on default images, while custom images need their own cloud-init.
  - Private networks for VPS and VDS: a paid add-on per instance. Joining the first network requires a reinstall.
  - Firewall endpoints (create, rules, attach), tags/RBAC, and S3-compatible object storage (one purchase per location, with auto-scale).
  - Storage VPS is not supported by the API.
  - Source: [Contabo API](https://api.contabo.com/)
- **Terraform:** an official provider, contabo/terraform-provider-contabo, manages Cloud VPS, VDS and S3 object storage. — [GitHub](https://github.com/contabo/terraform-provider-contabo)
- **Prices:** private networking €2.29/mo, Auto Backup €6.70/mo (Cloud VPS 12), object storage €2.49 per 250 GB. — [Contabo configurator](https://contabo.com/en-us/vps/cloud-vps-4/?addons=1&image=ubuntu.332&qty=1&contract=1&storage-type=vps-4-100-gb-ssd)
- **Snapshots:** 1–3 included depending on plan. — [Contabo VPS](https://contabo.com/en-us/vps/)
- **Extra storage:** sold as a disk upgrade, for example 400 → 800 GB SSD for €6/mo on Cloud VPS 12. — [Contabo configurator](https://contabo.com/en-us/vps/cloud-vps-4/?addons=1&image=ubuntu.332&qty=1&contract=1&storage-type=vps-4-100-gb-ssd). The VDS page says more storage is available without listing options. — [Contabo VDS](https://contabo.com/en-us/vds/)
- **Kubernetes support:** a third party says Contabo offers "self-managed only" Kubernetes (clarification dated 2026-04-27). — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)

### Inferences
- On a full KVM guest running stock Ubuntu, overlay, br_netfilter and wireguard (in-tree since Linux 5.6) should be available. These are standard k3s prerequisites, and nothing I found suggests Contabo strips them. I did not verify this directly.
- **Single node:** private networking is not needed, which saves €2.29/mo.
- **Missing nested virtualization** rules out Firecracker/Kata-style microVM sandboxes for the agent pods. gVisor or plain runc still work.
- **Storage:** with no separate block-volume product, 20Gi PVCs come from local-path on the root disk. Disk size and the 4k IOPS (about 32k mixed in the Sep 2026 test) are the limits.

### Gaps
- I found no Contabo-specific k3s write-up for 2025–26.
- I could not confirm a custom-image upload size limit or cost (truncated in the API docs).
- I could not confirm whether the Contabo firewall is a free feature on all plans.

## 6. ToS/AUP restrictions on CPU-heavy or continuous workloads, AI agents and k8s

### Takeaway
Nothing bans Kubernetes or AI agents. The T&Cs do forbid programs that could "extensively wear and/or tear" hardware or bandwidth. Contabo can also set undisclosed "limit values" and block servers until a breach is fixed. Sustained 100% CPU is a gray area: some users report running at full load for a day with no action.

### Cited Findings
- **Clause 9(1):** prohibits "any scripts and programs that could potentially extensively wear and/or tear Provider's hardware or bandwidth." The provider may set its own "limit values," and exceeding them generally counts as a violation. — [Contabo T&C](https://contabo.com/en/legal/terms-and-conditions/)
- **Clause 9(3) and 9(5):** Contabo may restrict or block a server until a breach is remedied, and fees continue during the block. — [Contabo T&C](https://contabo.com/en/legal/terms-and-conditions/)
- **Crypto mining:** the T&C text I fetched has no crypto clause. Contabo published a separate blog table that classes crypto activities as allowed, "allowed, not recommended," or prohibited. A LowEndTalk user recalls that mining on VPS is prohibited as noisy-neighbor behavior. — [LowEndSpirit](https://lowendspirit.com/discussion/2992/contabo-announced-what-type-of-crypto-tasks-are-allowed-to-be-run-on-their-servers); [LET comment](https://lowendtalk.com/discussion/comment/3240318/)
- **Sustained load in practice:** one user reports maxing the CPU for 20–24 h while rendering a map, with no known throttling. — search summary of [LET CPU usage limitations](https://lowendtalk.com/discussion/172063/question-on-contabo-cpu-usage-limitations)
- **Benchmark practice:** vpsbenchmarks runs endurance tests at only about 50% CPU, because "maxing out the cpu might be considered abusive." — [vpsbenchmarks endurance](https://www.vpsbenchmarks.com/trials/contabo_performance_trial_28Apr2025/endurance_runs/last)

### Inferences
- Coding agents with occasional compile bursts are unlikely to trigger action.
- Running 8 agents that keep shared vCPUs pegged for hours could draw fair-use attention or throttling on Cloud VPS. VDS (dedicated cores) is the safer choice for sustained load.

### Gaps
- I did not read the full AUP or the crypto blog post directly.
- Contabo publishes no numeric CPU threshold.

## 7. 2026 price changes

### Takeaway
2026 brought a relaunch, not a simple increase. The old Cloud VPS 10–60 became Cloud VPS 4–18 and Plus 4–18. One third party logged the entry price rising from about €3.60 to €4.50 (2026-08-03). Contabo currently shows €4.40 (24-month) or €5.50 (monthly) for the entry plan. Setup fees appear to be gone.

### Cited Findings
- Entry price change on 2026-08-03 from €3.60 to €4.50/mo. — [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Current entry price:** €4.40 on 24 months and €5.50 monthly for Cloud VPS 4. — [Contabo VPS](https://contabo.com/en-us/vps/)
- **Setup fees:** none on any term in the current configurator. learnwithhasan recorded on 2026-04-27 that setup fees applied to Cloud VPS 10 only, so there was a setup fee under the old lineup. — [Contabo configurator](https://contabo.com/en-us/vps/cloud-vps-4/?addons=1&image=ubuntu.332&qty=1&contract=1&storage-type=vps-4-100-gb-ssd); [learnwithhasan](https://learnwithhasan.com/vps-providers/contabo-vps/)
- **Trend context:** high RAM and SSD prices in 2026 are being noted in the hardware market. This is general context, not Contabo-specific. — [Notebookcheck](https://www.notebookcheck.net/Amazon-January-CPU-sales-tank-51-year-over-year-as-high-RAM-and-SSD-prices-kill-budget-desktop-builds.1225314.0.html)

### Inferences
- The 4/6/8 naming reflects vCPU count. The per-vCPU price is very low, which is consistent with the heavy oversubscription seen in benchmarks.

### Gaps
- I found no official Contabo announcement of the 2026 relaunch or of its exact date.
