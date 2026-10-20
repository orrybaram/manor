# US Budget VPS / Dedicated Competitors to Contabo (as of Oct 2026)

Context: a single-node k3s cluster running 3–8 coding-agent pods (1 CPU/2GiB to 2 CPU/4GiB each, 20Gi volumes, occasional CPU-heavy compiles). The target box is about 8–16 vCPU and 16–64 GB RAM. Research date: 2026-10-15. All prices are USD/month unless noted. Each price has a source and a date. Many came from third-party aggregators because some provider pages could not be fetched or had no prices. Check checkout pages before ordering.

## Plans and prices near 4–16 vCPU / 8–64 GB, per-unit cost, intro vs renewal pricing, contract terms, US locations

### Takeaway
On list price, the cheapest options in the target size are Hostinger KVM 8 (8 vCPU/32 GB, $25.99 intro, $49.99 renewal), OVHcloud US VPS-4 (8 vCore/24 GB, from $23.37 with a 12-month commitment), and InterServer ($3 per slice; 16 cores/64 GB for $96, month-to-month, no promo cliff). BuyVM is cheap per GB, but its High Volume tiers stop at 7 cores. RackNerd and GreenCloud standard (non-promo) pricing is poor value at this size. LowEnd promo deals are mostly ≤8 GB RAM.

### Cited Findings

**Hostinger VPS (KVM)**
- Official page, fetched 2026-10-15: KVM 1 (1 vCPU/4 GB/50 GB NVMe/4 TB) costs $6.49 intro and $11.99 renewal. KVM 2 (2/8 GB/100 GB/8 TB) costs $8.99 → $14.99. KVM 4 (4/16 GB/200 GB/16 TB) costs $12.99 → $28.99. KVM 8 (8/32 GB/400 GB/32 TB) costs $25.99 → $49.99. Plans are prepaid for the whole term, and renewal is quoted "for 2 years". — [Hostinger VPS](https://www.hostinger.com/vps-hosting)
- Findstack, verified 2026-08-17: KVM 8 is $25.99 promo and $49.99 renewal on a 24-month promo term. Learnwithhasan, checked 2026-08-03, says KVM 8 renews near $49.99/mo, a 92% increase. — [Findstack](https://findstack.com/resources/hostinger-black-friday-2026); [Learnwithhasan](https://learnwithhasan.com/vps-providers/hostinger-vps/)
- Conflicting figure: RamNode, a competitor, lists KVM 8 at $19.99 intro and $39.99 renewal on a 48-month term. This was probably an older or longer-term promo. — [RamNode comparison](https://www.ramnode.com/ramnode-hostinger)
- Per-unit cost for KVM 8: about $3.25/vCPU and $0.81/GB at intro; about $6.25/vCPU and $1.56/GB at renewal. These are computed from the official prices above.
- US locations are not named on the plan page, which says "10 data centers across 4 continents, from Boston to Jakarta." — [Hostinger VPS](https://www.hostinger.com/vps-hosting)

**OVHcloud US VPS (brief)**
- us.ovhcloud.com, fetched 2026-10-15 and labelled "VPS 2027": VPS-1 (2 vCore/4 GB/40 GB) from $4.54. VPS-2 (4/8 GB/75 GB, 1 Gbps) from $8.50. VPS-3 (6/12 GB/100 GB, 2 Gbps) from $12.32. VPS-4 (8/24 GB/200 GB NVMe, 3 Gbps) from $23.37. These are "starting at" prices tied to a 12-month upfront option, and the no-commitment rate is not shown. — [OVHcloud US VPS](https://us.ovhcloud.com/vps/)
- The September 2025 lineup announcement covered six configurations, from 4 vCore/8 GB/75 GB up to 24 vCore/96 GB/400 GB NVMe. The page showing 2026-10 lists only four. — [vpsbenchmarks announcement](https://www.vpsbenchmarks.com/announcements/ovhcloud_us-new-vps-2026-01)
- VPS-4 per-unit cost: about $2.92/vCPU and $0.97/GB, computed on the committed price.

**InterServer**
- Official page, fetched 2026-10-15: $3 per slice per month. Each slice adds 2 GB RAM, 40 GB SSD and 2 TB transfer. Cores grow about 1 per 2 slices, so 32 slices = 16 cores, 64 GB, $96/mo. The VPS uses a 10 Gbps shared port. — [InterServer VPS](https://www.interserver.net/vps/)
- WHTOP, Jan 2026, lists 8 slices = 4 cores/16 GB/$24, 15 slices = 8 cores/30 GB/$45, and 32 slices = 16 cores/64 GB/$96. This matches the official page. — [WHTOP 8 slices](https://www.whtop.com/plans/interserver.net/134615); [WHTOP 32 slices](https://www.whtop.com/plans/interserver.net/134639)
- Terms: billed monthly and cancel anytime. There is "no trial period or money-back guarantee on VPS hosting" and no yearly discount. — [InterServer VPS](https://www.interserver.net/vps/)
- US locations: New York City, Dallas, Los Angeles. — [InterServer VPS](https://www.interserver.net/vps/)
- Per-unit cost: $6/core and $1.50/GB, the same at every size and at renewal. A coupon blog says the price doesn't rise at renewal, and Expanse (a competitor) calls the pricing "price-locked". — [tuxxin](https://tuxxin.com/blog/cheapest-vps-hosting-2026-coupon-codes); [Expanse](https://expanse.host/compare/interserver)

**BuyVM (Frantech)**
- Official page, fetched 2026-10-15. The KVM Slices stop at Slice 4096 (1 dedicated core/4 GB/80 GB, $15). The High Volume plans are 2c/8 GB/160 GB $30, 3c/12 GB/240 GB $45, 4c/16 GB/320 GB $60, 5c/20 GB/400 GB $75, 6c/24 GB/480 GB $90, and 7c/28 GB/560 GB $105. All cores run at 3.50+ GHz with unmetered 1 Gbps bandwidth. — [BuyVM slices](https://buyvm.net/kvm-dedicated-server-slices/)
- Per-unit cost: $15/core and $3.75/GB, but the cores are dedicated (see the virtualization section).
- Locations: Las Vegas and New York in the US, plus Luxembourg. The page shows an "Out of stock" notice and points buyers to Cloudzy. — [BuyVM slices](https://buyvm.net/kvm-dedicated-server-slices/)
- Learnwithhasan also says BuyVM is frequently out of stock. — [Learnwithhasan BuyVM](https://learnwithhasan.com/self-hosting-hub/vps-providers/buyvm/)

**RackNerd**
- The official KVM page, fetched 2026-10-15, shows standard (non-promo) pricing. The largest plans are 6 vCPU/8 GB/220 GB/5 TB at $36.59/mo and 7 vCPU/12 GB/300 GB/6 TB at $55.99/mo. — [RackNerd KVM](https://www.racknerd.com/kvm-vps)
- Promo pricing is far cheaper but small. The largest standing KVM promo is "6 GB / 4 cores / 140 GB / 12 TB" at $59.99/yr (third-party listings). An official promo page shows an 8 GB tier at $119.99/yr. — [RackNerd 11-11 page](https://racknerd.com/11-11); [LowEndBox](https://lowendbox.com/?p=50923)
- LowEndBox, Dec 2025 and Jan 2026, lists 8 GB/6 vCPU/150 GB/20 TB at $62.49/yr. I found no 16 GB+ KVM promo. — [LowEndBox](https://lowendbox.com/?p=50923); [LowEndBox](https://lowendbox.com/?p=51180)
- US locations: Los Angeles, San Jose, Seattle, Dallas, Atlanta, Chicago, New York and Ashburn. — [RackNerd KVM](https://www.racknerd.com/kvm-vps)

**GreenCloudVPS**
- Official Budget KVM page, fetched 2026-10-15: SSDKVM-4 (4 cores/8 GB/60 GB SSD/8 TB, 10 Gbps) at $40/mo and SSDKVM-5 (8 cores/16 GB/120 GB/12 TB) at $80/mo. Only monthly billing is listed. — [GreenCloud Budget KVM](https://greencloudvps.com/budget-kvm-vps.php)
- US locations: LA, San Jose, Dallas, Chicago, Ashburn, Jacksonville, Kansas City, Ogden, Buffalo, Staten Island, Phoenix. — [GreenCloud Budget KVM](https://greencloudvps.com/budget-kvm-vps.php)
- LowEndTalk deals were far cheaper, for example a San Jose budget plan with 16 GB at $125 for 3 years. That deal is old and only ran during anniversary promos. A GreenCloud rep says a 7-day refund applies to the standard budget plans. — [LowEndTalk](https://lowendtalk.com/discussion/comment/3700649/); [LowEndTalk](https://lowendtalk.com/discussion/comment/3737924/)

**Ultahost**
- Official VPS page, fetched 2026-10-15, at 24-month rates: 1c/1 GB $5.52, 2c/2 GB $9.78, 3c/4 GB $15.87, 4c/6 GB $20.69. Terms are monthly, yearly (−30%), 2 years (−40%) or 3 years (−50%). — [Ultahost VPS](https://ultahost.com/vps-hosting)
- Its "POWER" VDS line includes 6 cores/12 GB at about $38.80 and 24 cores/64 GB at about $224.80, both at 24-month discounted rates (WHTOP, 2025–26). — [WHTOP POWER Pro](https://www.whtop.com/plans/ultahost.com/128083); [WHTOP POWER Turbo](https://www.whtop.com/plans/ultahost.com/128088)
- Dupple, Jul 2026, says Ultahost renewals are typically 30–50% higher than intro pricing. — [Dupple](https://dupple.com/reviews/ultahost)

**HostHatch**
- The vpsbenchmarks listing (data from 2022) shows NVMe 16GB as 4 vCPU (EPYC Milan)/16 GB/75 GB/4 TB at $15/mo, or $14.17 with a 1-year commitment. — [vpsbenchmarks](https://vpsbenchmarks.com/hosters/hosthatch/plans/nvme-16gb)
- A LowEndSpirit post from 2022 describes "4 cores (2 dedicated, 2 fair share) + 16GB + 75GB" for $15. A GitHub list describes 4 cores (2 dedicated)/16 GB/200 GB NVMe/25 TB at $100/yr, undated. — [LowEndSpirit](https://lowendspirit.com/discussion/comment/86546); [GitHub list](https://github.com/qfzn856/HostHatch)
- HostHatch's product page returned no content when fetched, so I have no 2026 official price.

**Other LowEnd / large-RAM US options**
- Zonode Extreme KVM, listed 2026-02-04: 8 vCores/32 GB/120 GB, unmetered, US, $58/mo, 30-day money-back guarantee. The listing does not say whether cores are dedicated. — [WHTOP Zonode](https://www.whtop.com/plans/zonode.com/143568)

**Budget US dedicated servers**
- ReliableSite (LowEndSpirit post): EPYC 4545P (16 cores)/64 GB/1 TB NVMe at $99/mo. Ryzen 5600X/64 GB/512 GB NVMe at $79/mo, a listing edited Aug 2025. — [LowEndSpirit ReliableSite](https://lowendspirit.com/discussion/9818/dedicated-servers-from-49-mo-amd-epyc-4545p-amd-ryzen-core-i9-10900k-xeon-and-more)
- HostMayo (LowEndSpirit): Ryzen 5 3600/64 GB/1 TB NVMe/1 Gbps at $100/mo, and Ryzen 7 5700G with the same specs at $110/mo. — [LowEndSpirit HostMayo](https://lowendspirit.com/discussion/10818/dedicated-servers-ryzen-intel-more-us-eu-1gbps-unmetered)
- A 2026 buyer's guide (commercial) puts a current Ryzen with 64 GB and 2x NVMe in RAID 1 at $90–100/mo in the US. It flags DDR3, HDD, 100 Mbps ports and 5 TB caps as red flags. — [websnp](https://websnp.com/blog/dedicated-server-under-100-month)

### Inferences
- Hostinger KVM 8 has the lowest headline price for 8 vCPU/32 GB. Over 4 years, though, the renewal ($49.99) roughly doubles the cost, so compare total 4-year cost rather than intro price against Contabo.
- InterServer is the most transparent for sizing: buy 16–24 slices (8–12 cores, 32–48 GB) for $48–72 month-to-month with no promo cliff. However, its cores are older and slower (see below).
- BuyVM is the "honest dedicated core" option, but stock is unreliable, and 7 cores/28 GB for $105 is pricey per unit.
- A budget dedicated server at about $80–100 for 16 cores/64 GB beats every VPS here on sustained-CPU value for compile-heavy agents.

### Gaps
- No official 2026 HostHatch price list (page fetch failed). No current RackNerd 16 GB+ KVM promo found.
- OVH US no-commitment monthly prices and city list were not on the fetched page.
- Ultahost US VPS sizes above 6 GB, and its US cities, were not on the fetched page.
- Hostinger's US data center cities were not confirmed. The "Boston" mention suggests at least one is in the US.

## Virtualization, dedicated vs shared cores, oversubscription, benchmarks/steal, fair-CPU-use policies

### Takeaway
All of these providers are KVM-based. Only BuyVM (Slice 4096 and probably the High Volume tiers) and HostHatch (partially) document dedicated cores. Hostinger shows low measured steal on recent hardware. RackNerd's ToS discourages "maxing out" shared VPS CPU and points heavy users to dedicated servers.

### Cited Findings
- BuyVM: Slices 512/1024/2048 are "Fair Share"; Slice 4096 is "Dedicated", and the page claims "no overselling" on nodes. The High Volume tiers' CPU policy is not stated on the page. A third-party GitHub review says the High-Vol tiers are dedicated. — [BuyVM](https://buyvm.net/kvm-dedicated-server-slices/); [GitHub BuyVM review](https://github.com/mbspa4/BuyVM)
- RackNerd ToS: it sets no numeric CPU threshold. It asks VPS users to avoid usage "abusive to the Disk I/O or CPU". It also says: "If you require dedicated resources and want to max it out, we would recommend getting your own dedicated server." It prohibits "Excessive resource use that disrupts our network or other clients" and bans CPU mining. Penalties range from a warning through suspension to termination without refund. — [RackNerd ToS](https://www.racknerd.com/terms-of-service)
- RackNerd's KVM page names only "Intel Xeon" CPUs and does not say whether cores are dedicated. — [RackNerd KVM](https://www.racknerd.com/kvm-vps)
- Hostinger, vpsbenchmarks 24h endurance runs at about 50% load per core: KVM 8 in Jul 2025 had 0.00% max steal. KVM 2 in Oct 2025 had 3.59% max. KVM 1 in Nov 2025 had 1.14% max. KVM 8 in Aug 2023 (Xeon Silver 4214) had 10.5% max. — [vpsbenchmarks Jul 2025](https://www.vpsbenchmarks.com/trials/hostinger_performance_trial_16Jul2025/endurance_runs); [Oct 2025](https://www.vpsbenchmarks.com/trials/hostinger_performance_trial_14Oct2025/endurance_runs); [Nov 2025](https://www.vpsbenchmarks.com/trials/hostinger_performance_trial_28Nov2025/endurance_runs); [Aug 2023](https://www.vpsbenchmarks.com/trials/hostinger_performance_trial_30Aug2023/endurance_runs)
- Hostinger's VPS limits/fair-use support article URL returned 404, and the plan page does not state CPU limits. — [Hostinger VPS](https://www.hostinger.com/vps-hosting)
- InterServer: KVM for Linux. Dedicated vs shared CPU is not stated on the official page. — [InterServer VPS](https://www.interserver.net/vps/)
- Valebyte (a competitor, May 2026) claims InterServer runs 2.1–2.4 GHz CPUs and sees 10–15% I/O wait at peak. Expanse (also a competitor) says InterServer hardware is "older". Treat both as biased. — [Valebyte](https://www.valebyte.com/en/blog/interserver-vs-valebyte-the-difference-in-2026/); [Expanse](https://expanse.host/compare/interserver)
- HostHatch NVMe 16GB is listed as shared (not dedicated) CPU. Its vpsbenchmarks grades (Sep 2022) are Raw CPU B (15.95/20), Performance Stability C (11.33/20), and Disk I/O A, with over 3,000 MiB/s read+write. — [vpsbenchmarks HostHatch](https://vpsbenchmarks.com/hosters/hosthatch/plans/nvme-16gb)
- Ultahost says VPS resources are "dedicated solely to you" / "guaranteed", but it does not say that vCPUs are dedicated cores. The "dedicated VM performance" wording appears on its VDS line instead. — [Ultahost VPS](https://ultahost.com/vps-hosting)
- GreenCloud's Budget KVM page has no fair-use text and no statement about dedicated cores. — [GreenCloud](https://greencloudvps.com/budget-kvm-vps.php)
- OVH US does not say whether vCores are dedicated or shared. — [OVHcloud US VPS](https://us.ovhcloud.com/vps/)

### Inferences
- For bursty agent workloads (mostly idle, with occasional compiles), shared-core VPSes like Hostinger, OVH and InterServer are probably fine. Sustained 100% load across all cores risks throttling or warnings on RackNerd and other LowEnd hosts.
- HostHatch's "C" stability grade and the absence of dedicated-core guarantees on most hosts suggest benchmarking with YABS plus a sustained `stress-ng` run in the first refund window.

### Gaps
- I found no 2025–2026 YABS or Geekbench numbers for InterServer, GreenCloud, Ultahost or RackNerd large plans.
- I could not find Hostinger's written CPU fair-use thresholds.
- Oversubscription ratios are not disclosed by any of these providers.

## Bandwidth limits

### Takeaway
At this workload (git clones and API traffic), bandwidth isn't a deciding factor. Every provider gives several TB or unmetered.

### Cited Findings
- Hostinger: 4/8/16/32 TB for KVM 1/2/4/8. — [Hostinger](https://www.hostinger.com/vps-hosting)
- InterServer: 2 TB per slice on a 10 Gbps shared port. — [InterServer](https://www.interserver.net/vps/)
- BuyVM: unmetered on a 1 Gbps port. — [BuyVM](https://buyvm.net/kvm-dedicated-server-slices/)
- OVH US: unlimited traffic at 500 Mbps–3 Gbps, depending on plan. — [OVHcloud US](https://us.ovhcloud.com/vps/)
- RackNerd: 5–6 TB on the standard 8–12 GB plans, and 12–20 TB on promos. — [RackNerd KVM](https://www.racknerd.com/kvm-vps); [LowEndBox](https://lowendbox.com/?p=50923)
- GreenCloud: 8–12 TB on a 10 Gbps port. — [GreenCloud](https://greencloudvps.com/budget-kvm-vps.php)
- HostHatch: 4 TB on the 16 GB plan (2022 data). — [vpsbenchmarks](https://vpsbenchmarks.com/hosters/hosthatch/plans/nvme-16gb)

### Inferences
- None of these limits would bind for 3–8 agent pods.

### Gaps
- Overage pricing was not collected.

## k3s friendliness: kernel modules, snapshots/backups, private networking, block storage, API

### Takeaway
All of these are full KVM guests, so k3s kernel needs (overlay, br_netfilter, iptables/nftables) should work. Snapshots and backups vary: Hostinger, Ultahost, OVH and BuyVM include some, while RackNerd and InterServer offer little or rely on paid add-ons. Only BuyVM (block slabs) and OVH have notable storage or API extras.

### Cited Findings
- Hostinger: free weekly backups and a Public API on every plan. Snapshots are not mentioned on the plan page. — [Hostinger](https://www.hostinger.com/vps-hosting)
- OVH US: daily backups (rolling 7 days) included. Premium automatic backup starts at $1.40/mo and snapshots at $0.40/mo. Local Zone VPS is Linux-only and has no extra IPs or load balancer. — [OVHcloud US](https://us.ovhcloud.com/vps/)
- BuyVM: block storage "slabs" cost $1.25/mo per 256 GB and can be moved between services in the same location without downtime. Backups cost 10% of the base price (nightly, 7 kept), and there are 5 free snapshots per location. — [BuyVM](https://buyvm.net/kvm-dedicated-server-slices/)
- InterServer: no built-in snapshots are listed. Off-server backups are a paid add-on (Cloud Remote Backup Service). — [InterServer](https://www.interserver.net/vps/)
- RackNerd: the KVM page lists no backups or snapshots, only an OS reinstall. Upgrading to the next plan needs about 1 minute of reboot downtime. Up to 100 IPv6 addresses are available by ticket in LA. — [RackNerd KVM](https://www.racknerd.com/kvm-vps)
- Ultahost: "Free Real-Time Snapshot", free weekly backups, and instant snapshots from the panel. — [Ultahost](https://ultahost.com/vps-hosting)

### Inferences
- A single-node k3s install with local-path storage needs no block storage or private networking. Disk size matters more: 8 pods × 20Gi plus images is about 200+ GB. On that measure Hostinger KVM 8 (400 GB), InterServer (40 GB/slice) and BuyVM (320+ GB, plus slabs) are comfortable. GreenCloud (120 GB at 16 GB RAM) and HostHatch (75 GB) are tight.
- Without provider snapshots (RackNerd, InterServer), you'd need Velero, restic or etcd snapshots of your own.

### Gaps
- No provider documents kernel module restrictions. KVM normally allows a custom kernel, but I found no explicit confirmation for these providers.
- Private networking was not documented for any of these providers on the fetched pages.

## Reliability/support reputation 2025–2026 and ToS on sustained CPU

### Takeaway
Reputation data was thin in this pass. The concrete items are RackNerd's "get a dedicated server if you max it out" ToS stance, reports of slow HostHatch support (2022), chronic BuyVM stock shortages, and InterServer's no-refund VPS policy.

### Cited Findings
- RackNerd ToS on sustained CPU (quoted above): VPS use must not be "abusive to the Disk I/O or CPU", and sustained max usage should go to dedicated servers. — [RackNerd ToS](https://www.racknerd.com/terms-of-service)
- A 2022 LowEndSpirit post reports that HostHatch support tickets could take over a month to answer. — [vpsbenchmarks/LES summary](https://lowendspirit.com/discussion/comment/86509)
- BuyVM's page shows "Out of stock" and redirects to Cloudzy. — [BuyVM](https://buyvm.net/kvm-dedicated-server-slices/)
- InterServer has no trial and no money-back guarantee on VPS. — [InterServer](https://www.interserver.net/vps/)
- Ultahost is rated 3.8/5 by Dupple (Jul 2026) and 4.9/5 by Capterra (44 reviews, a small sample). — [Dupple](https://dupple.com/reviews/ultahost); [Capterra](https://www.capterra.com/p/249700/Ultahost/)
- Zonode offers a 30-day money-back guarantee, and GreenCloud a 7-day refund on budget plans. — [WHTOP Zonode](https://www.whtop.com/plans/zonode.com/143568); [LowEndTalk](https://lowendtalk.com/discussion/comment/3737924/)

### Inferences
- If you expect sustained heavy compiles, avoid LowEnd promo boxes (RackNerd, GreenCloud promos). Prefer a dedicated server or dedicated-core plans.

### Gaps
- I found no 2025–2026 Reddit or LowEndTalk outage or support threads for Hostinger, InterServer or OVH US in this pass. Reputation claims beyond the items above are unverified.
- Hostinger's written CPU-abuse policy was not found (support URL 404).
