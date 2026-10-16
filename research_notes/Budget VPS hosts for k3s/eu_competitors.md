# European-origin budget VPS/dedicated providers as Contabo competitors (as of Oct 2026)

Context: a single-node k3s cluster running 3–8 coding-agent pods (1 CPU/2 GiB or 2 CPU/4 GiB each, 20 Gi volume, git clones, Claude Code, occasional CPU-heavy compiles), with a user who is probably in the US. The target node is about 8–16 vCPU and 16–64 GB RAM. I fetched prices on 2026-10-15 unless another date is given. Prices are monthly and exclude VAT unless marked otherwise. Per-unit math is my own and is computed from the cited list price.

## 1. Current plans, prices, terms and US availability by provider

### Takeaway
Netcup VPS is the closest like-for-like Contabo competitor at the 8–16 vCPU size: €27–67/mo for 8–16 shared vCores and 16–64 GB, with a US site in Manassas, VA. Netcup Root Servers (dedicated cores) cost about €41–148. OVHcloud VPS-4 is the cheapest per unit, but it stops at 8 vCPU/24 GB. Hetzner Cloud is no longer a budget option after the June 15, 2026 repricing. The cheap CX/CAX lines appear unavailable, and US CPX/CCX now cost €120–280 for 8–16 vCPU. Hetzner's EU-only dedicated "LTD" boxes are the remaining Hetzner value. IONOS is cheap only for the 3-month intro period. Scaleway is not budget-tier.

### Cited Findings

**Netcup (Germany; sites VIE, NUE, AMS, Manassas USA "MNZ", SIN)**
- VPS G12.5 (shared vCores, x86), 12-month-term price per month, net / incl. 19% VAT [netcup VPS page](https://www.netcup.com/en/server/vps):
  - VPS 500: 2 vCore / 4 GB / 64 GB, €8.26 / €9.50
  - VPS 1000: 4 / 8 GB / 128 GB, €14.50 / €16.68
  - VPS 2000: 8 / 16 GB / 256 GB, €26.92 / €30.96
  - VPS 4000: 12 / 32 GB / 512 GB, €45.36 / €52.16
  - VPS 8000: 16 / 64 GB / 1 TB, €67.11 / €77.16
- Terms are 1, 12 or 24 months. The page says 12 months saves 13% and 24 months saves 26% versus monthly. The page shows only the 12-month price and does not mention a setup fee. The location cannot be changed after setup. The page also doesn't say which plans are offered in every location, so Manassas availability per plan is unconfirmed. [netcup VPS page](https://www.netcup.com/en/server/vps)
- VPS plans explicitly do not include dedicated cores or the 99.9% availability SLA, which are root-server features. Snapshots, a remote console, DDoS protection and local block storage up to 8 TB are included or available. Block storage costs €0.01/GB/mo on the page, but the FAQ says €0.012/GB, so the page is inconsistent. [netcup VPS page](https://www.netcup.com/en/server/vps)
- Root Server G12.5 (dedicated cores, AMD EPYC 9645, NVMe), 12-month price per month, net / incl. VAT [netcup RS page](https://www.netcup.com/en/server/root-server):
  - RS 1000: 4 cores / 8 GB / 128 GB, €21.73 / €25.00
  - RS 2000: 8 / 16 GB / 256 GB, €40.70 / €46.81
  - RS 4000: 12 / 32 GB / 512 GB, €77.83 / €89.50
  - RS 8000: 16 / 64 GB / 1 TB, €148.42 / €170.69
  - RS 12000 and RS 16000 (20c/96 GB and 24c/128 GB) are "request now" only.
  - Locations: VIE, NUE, MNZ (USA), SIN. Per-plan availability is not stated.
- Since September 2026 netcup has sold generation "G12.5", which has the same vCore/RAM as G12 but half the built-in storage on VPS 1000 (128 GB instead of 256 GB). The reviewer says netcup "no longer want to guarantee NVMe". [serverkueche, Oct 2026](https://serverkueche.de/en/tutorials/netcup-vps-1000-benchmark/)
- Per-unit math (net, 12-month term):
  - VPS 2000: €3.37/vCPU, €1.68/GB
  - VPS 4000: €3.78/vCPU, €1.42/GB
  - VPS 8000: €4.19/vCPU, €1.05/GB
  - RS 2000: €5.09/core
  - RS 4000: €6.49/core
  - RS 8000: €9.28/core, €2.32/GB

**Hetzner (Germany; cloud in FSN/NBG/HEL, Ashburn ASH1, Hillsboro HIL1, SIN; dedicated in DE/FI only)**
- Official price-adjustment table, effective 15 June 2026 08:00 CEST, for new orders and cloud rescales; existing servers keep their old price. EUR/mo excluding VAT. [Hetzner docs](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
  - EU, shared Cost-Optimized line:
    - CX43 (8 vCPU / 16 GB): €11.99 → €15.99
    - CX53 (16 / 32): €22.49 → €29.49
    - CAX31 (Arm, 8 / 16): €15.99 → €20.99
    - CAX41 (16 / 32): €31.49 → €40.99
  - EU, shared Regular Performance line:
    - CPX42 (8 / 16): €25.49 → €69.49
    - CPX52 (12 / 24): €36.49 → €100.49
    - CPX62 (16 / 32): €50.49 → €129.99
  - EU, dedicated-vCPU line:
    - CCX33 (8 / 32): €62.49 → €138.49
    - CCX43 (16 / 64): €124.99 → €275.99
  - US (ASH/HIL):
    - CPX31 (4 / 8): €20.99 → €62.49
    - CPX41 (8 / 16): €38.99 → €120.49
    - CPX51 (16 / 32): €77.99 → €237.99
    - CCX23: €33.99 → €87.49
    - CCX33: €64.99 → €140.99
    - CCX43: €129.99 → €279.49
    - There are no CX/CAX plans in the US.
- Specs for the US line [Hetzner Regular Performance page](https://www.hetzner.com/cloud/regular-performance/); [Hetzner General Purpose page](https://www.hetzner.com/cloud/general-purpose/):
  - CPX41: 8 vCPU / 16 GB / 240 GB / 4 TB traffic
  - CPX51: 16 / 32 GB / 360 GB / 5 TB
  - CCX33: 8 dedicated / 32 GB / 240 GB, 3 TB in the US vs 30 TB in the EU
  - CCX43: 16 / 64 GB / 360 GB, 4 TB in the US vs 40 TB in the EU
  - Listed prices include IPv4.
- An earlier round took effect on April 1, 2026, covering existing products and new orders. It was announced on 23 Feb 2026 and reported at about 30–37% for cloud in DE/FI. [Northflank](https://northflank.com/blog/hetzner-cloud-server-price-increases); [Vincent Schmalbach](https://www.vincentschmalbach.com/hetzner-cheap-cloud-unavailable-price-increases/). Server Auction prices reportedly rose a flat ~3% in April. One secondary source puts AX41 at €49.73 → €51.22 and EX44 at €42.30 → €47.30. [agentdeals.dev](https://agentdeals.dev/hetzner-pricing-2026); [falcao.org](https://falcao.org/posts/hetzner-not-cheap-anymore/). These are secondary sources and only partly consistent with each other.
- A HostHandbook article claims a separate 5–8% increase in July 2026. It conflicts with the other sources and should be treated as unreliable. (Search summary of [hosthandbook](https://hosthandbook.com/blog/hetzner-price-increase-2026))
- Availability:
  - The official status page has shown "Limited availability of cloud instances" since 26 June 2026. New customers and some randomly selected existing customers cannot create or rescale servers. Hetzner cites demand and hardware component shortages. [Hetzner status incident](https://status.hetzner.com/incident/0a75c7ae-3377-41dc-aabe-601063724d24)
  - By 7–8 Sep 2026, every CX and CAX model was marked "unavailable" while CPX still had Create buttons. [Vincent Schmalbach](https://www.vincentschmalbach.com/hetzner-cheap-cloud-unavailable-price-increases/)
  - When I fetched the pages on 2026-10-15, the CX/CAX, CPX and CCX pages all showed "This product is currently unavailable. Please check back later" on every plan. [Hetzner cost-optimized](https://www.hetzner.com/cloud/cost-optimized/), [regular-performance](https://www.hetzner.com/cloud/regular-performance/), [general-purpose](https://www.hetzner.com/cloud/general-purpose/). The prices on those pages were rendered by JavaScript and came through blank, so the status text could also be a scraping artifact; see Gaps.
  - A Sep 9 snapshot (incl. IPv4) priced CX43 at €16.49 (unavailable), CPX42 at €69.99 and CPX32 at €35.99. [Vincent Schmalbach](https://www.vincentschmalbach.com/hetzner-cheap-cloud-unavailable-price-increases/)
- Dedicated servers, new monthly prices from 15 June 2026 (DE/FI only), from the [Hetzner docs](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/):
  - AX42-1: €97.30
  - EX63-1: €147.30
  - AX102-1: €257.30
  - "Limited offering, while supply lasts" models:
    - AX41-1-LTD: €57.30
    - AX42-1-LTD: €77.30
    - EX44-1-LTD: €57.30
    - EX63-1-LTD: €97.30
  - A mirror lists AX42-1 at €115.79 / €187.30, which conflicts with the docs table (search summary). The official docs figure is preferred.
  - Setup fees reportedly rose too: AX42 went from €79 to €107, and AX41 stays at €0. [LowEndTalk via scour.ing](https://scour.ing/p/https://lowendtalk.com/discussion/214154/hetzner-increases-setup-fees-order-on-spacecore-at-the-old-price-while-you-can)
- Hetzner has no dedicated or auction servers in the US. US locations are cloud-only, as the pages above list only DE/FI for dedicated.
- Per-unit math:
  - EU CX53 (if obtainable): €1.84/vCPU, €0.92/GB
  - EU CAX41: €2.56/vCPU
  - EU CPX62: €8.12/vCPU
  - US CPX41: €15.06/vCPU
  - US CPX51: €14.87/vCPU
  - US CCX33: €17.62/vCPU, €4.41/GB

**OVHcloud (France; US via OVHcloud US, which has separate sites at Vint Hill VA and Hillsboro OR)**
- VPS "2027" range, USD "from" prices. The configurator links use `pricing=upfront12`, which suggests these are 12-month commitment prices. Unlimited traffic, 1 IPv4 included, and a daily backup of the last 24 h is included. [OVHcloud VPS page](https://www.ovhcloud.com/en/vps/)
  - VPS-1: 2 vCore / 4 GB / 40 GB / 500 Mbps, $4.54
  - VPS-2: 4 / 8 GB / 75 GB / 1 Gbps, $8.50
  - VPS-3: 6 / 12 GB / 100 GB / 2 Gbps, $12.32
  - VPS-4: 8 / 24 GB / 200 GB / 3 Gbps, $23.37
- OVHcloud US lists VPS-2 at $10.00 and VPS-4 at $27.50. VPSBenchmarks shows VPS-2 at "$8.50 (-15%) minimum 1 year". [VPSBenchmarks OVHcloud US](https://www.vpsbenchmarks.com/compare/ovhcloud_us). So US pay-monthly prices are probably about $10 and $27.50.
- The range tops out at 8 vCPU / 24 GB. A LowEndTalk thread says the 2027 line removed the old high-bandwidth top tiers and caps out at about 1.5 Gbit. That conflicts with the 3 Gbps the official page lists for VPS-4. [LowEndTalk](https://lowendtalk.com/discussion/218138/ovh-launches-2027-vps-line)
- Per-unit math for VPS-4: about $2.92–3.44/vCPU and about $0.97–1.15/GB.
- Kimsufi (OVH eco dedicated), USD, setup fee equal to one month, unlimited traffic, 500 Mbps guaranteed in EU/US/CA. Status was "Soon available", meaning out of stock, when fetched. Per-location availability is not shown. [Kimsufi page](https://eco.ovhcloud.com/en/kimsufi/)
  - KS-4: Xeon E3-1230v6, 4c/8t, 16–64 GB DDR4 ECC, 2×450 GB+ NVMe, $18.80/mo + $18.80 setup
  - KS-1: Xeon-D 1520, 4c/8t, 32 GB, $18.80
  - KS-B/KS-C: Xeon E5 v2 with 32 GB DDR3, $11.10–13.30
- OVH Rise-L dedicated (Ryzen 9 9950X, 16c/32t, 128 GB, 2×960 GB NVMe, 1 Gbps public + 1 Gbps private) costs $177/mo plus a $177 setup fee and was also "Soon available". [OVH bare-metal prices](https://www.ovhcloud.com/en/bare-metal/prices/)

**IONOS (Germany; data centres in US, UK, DE, ES)**
- VPS+ line, USD/mo, intro price for 3 months on a 1-year term, then the struck-through regular price. No setup fee, unlimited traffic at up to 1 Gbps, 1 IPv4 included, extra IPv4 $5/mo, 30-day money-back. Shared vs dedicated vCores is not stated. [IONOS VPS page](https://www.ionos.com/servers/vps)
  - L+: 4 vCore / 8 GB / 240 GB, $8 intro, $25 regular
  - XL+: 8 / 16 GB / 480 GB, $14 intro, $47 regular
  - XXL+: 12 / 24 GB / 720 GB, $20 intro, $68 regular
- Per-unit math at regular prices: XXL+ is $5.67/vCPU and $2.83/GB; XL+ is $5.88/vCPU.

**Scaleway (France; Paris, Amsterdam, Warsaw; no US region)**
- Hourly billing; monthly figures below are approximate. Egress is included, and public IPv4 is billed separately at a price the page doesn't give. Only Compute and Memory Optimized are stated to have dedicated physical cores. [Scaleway pricing](https://www.scaleway.com/en/pricing/virtual-instances/)
  - DEV1-L: 4 vCPU / 8 GB, €31.27/mo
  - BASIC2-A8C-16G: €75.48
  - BASIC2-A8C-32G: €100.59
  - BASIC2-A16C-32G: €150.89
  - BASIC2-A16C-64G: €201.18
  - GP1-S: 8 / 32, €139.24
  - PRO2-S: €163.06
  - POP2-HC-16C-32G (compute optimized): €310.68
- Per-unit math for BASIC2-A16C-64G: €12.57/vCPU.

### Inferences
- In the US, Netcup VPS 8000 (16 vCore / 64 GB, about €67 or roughly $78 net on a 12-month term, Manassas) is the closest Contabo-style "big shared VPS" option. If Manassas stocks the plan, it covers the full 8-pod scenario on RAM: 8 × 4 GiB = 32 GiB requested, with 64 GB available.
- Netcup RS 4000 (12 dedicated EPYC cores / 32 GB, €78) is the main "dedicated cores, still budget" option with a US site.
- After June 2026, Hetzner US cloud is 3–4× more expensive per vCPU than Netcup or OVH, so it is no longer a Contabo competitor on price. Hetzner's value now sits in EU dedicated LTD/auction boxes, which add transatlantic latency of about 90–110 ms to a US user. That latency matters little for agents working over git and APIs.
- OVH VPS-4 (8 vCPU / 24 GB at about $23–27.50) fits 3–5 pods. It cannot reach 16 vCPU on one VPS, so a 16-vCPU node at OVH means stepping up to dedicated hardware like Rise, which is currently out of stock.
- IONOS intro prices are a trap for a long-running node: renewal is about 3.4× the intro price.

### Gaps
- Netcup per-plan stock in Manassas, netcup's monthly (non-commitment) prices, and any setup fee. The page shows only 12-month prices.
- Live Hetzner cloud prices on the pricing pages came through blank (JS-rendered). I confirmed the "unavailable" status only through a third-party report from 7–9 Sep and my blank-price fetch. Someone should verify in the Hetzner Console.
- The Hetzner IPv4 add-on price and the per-TB traffic overage price are not on the fetched pages, which say only that list prices include IPv4.
- The official US price list for OVHcloud US (OVH US is a separate company with separate pricing) is not directly fetched.
- Specs for Hetzner AX41/AX42-LTD (CPU, RAM) were not fetched.
- I did not look at other EU budget hosts (for example Hostinger, which is Lithuanian; Webdock, which is Danish; or Time4VPS) for lack of time.

## 2. Shared vs dedicated vCPU, benchmarks and steal time

### Takeaway
Netcup VPS uses shared vCores, but 2026 single-plan tests show 0% steal. VPSBenchmarks still grades netcup RS stability at D. OVH VPS-2027 benchmarks weakly on CPU (grade E for VPS-2, C for VPS-4). Hetzner CPX/CX are shared and CCX is dedicated. For bursty compiles, dedicated cores (netcup RS, Hetzner CCX/dedicated, OVH Rise) are the safer choice.

### Cited Findings
- netcup VPS 1000 G12 in Vienna recorded 0 steal over the July 2026 test. A median of three runs in October 2026 also showed 0% steal. Single-thread sysbench fell from 1,495 events/s (28 Jul) to a 1,390 median (Oct). [serverkueche](https://serverkueche.de/en/tutorials/netcup-vps-1000-benchmark/); [DEV mirror](https://dev.to/serverkueche/netcup-vps-1000-g12-benchmarked-how-fast-is-it-really-5689)
- VPSBenchmarks trialed netcup RS 1000 G12 on 23 Jul 2026, grading it C for raw CPU, D for performance stability and D for network (search snippet). [VPSBenchmarks netcup trial](https://www.vpsbenchmarks.com/trials/netcup_performance_trial_23Jul2026); [compare](https://www.vpsbenchmarks.com/compare/netcup_vs_vultr)
- A July 2026 review says netcup vCores are shared and that sustained 100%-CPU workloads (miners, constant encoders, always-busy CI) attract throttling. [Valebyte](https://valebyte.com/en/blog/netcup-review-2026-the-price-performance-king-and-its-fine-print/)
- OVHcloud US VPSBenchmarks grades, out of 20 [VPSBenchmarks OVHcloud US](https://www.vpsbenchmarks.com/compare/ovhcloud_us):
  - VPS-2 2027 (trial 20 Jun 2026): Web E (6.4), Raw CPU E (6.5), Stability D (9.0), Disk C (10.9), Network E (6.5)
  - VPS-4 2027 (trial 18 Sep 2026): Web D (9.0), CPU C (12.1), Stability D (9.2), Disk B (14.6), Network B (13.5)
  - Provider consistency score: 73
- Hetzner CCX means "dedicated vCPUs, constant high CPU usage", while the CX/CAX/CPX lines are shared resources. [Hetzner cloud](https://www.hetzner.com/cloud)
- Scaleway states dedicated physical cores only for its Compute and Memory Optimized families. [Scaleway pricing](https://www.scaleway.com/en/pricing/virtual-instances/)

### Inferences
- Coding agents mostly sit idle waiting on LLM API calls, with short CPU spikes from compiles and tests. That duty cycle fits shared vCPU at netcup or OVH. Netcup's documented sensitivity to sustained 100% use only matters if pods compile constantly.
- I found no hard numbers on oversubscription ratios for any provider.

### Gaps
- No 2026 YABS/Geekbench numbers for the netcup VPS 8000/4000 or the Manassas location.
- No steal-time data for OVH VPS-2027 or for Hetzner CPX after the repricing.

## 3. Traffic and egress limits

### Takeaway
Every EU budget option includes generous or unlimited traffic, and egress is not a concern for an agent node. Hetzner US is the stingiest at 3–5 TB, while its EU locations include 20–40 TB.

### Cited Findings
- Hetzner traffic allowances [Hetzner RP](https://www.hetzner.com/cloud/regular-performance/), [GP](https://www.hetzner.com/cloud/general-purpose/):
  - EU CPX: 20 TB
  - US CPX41/51: 4–5 TB
  - CCX33/43: 30–40 TB in the EU, 3–4 TB in the US
  - The overage rate per TB is not shown on the fetched page.
  - Bandwidth is not guaranteed; Hetzner says to expect about 300–500 Mbit.
- OVH VPS has unlimited traffic at 500 Mbps–3 Gbps. [OVH VPS](https://www.ovhcloud.com/en/vps/) Kimsufi is unlimited at 500 Mbps. [Kimsufi](https://eco.ovhcloud.com/en/kimsufi/)
- IONOS VPS+ has unlimited traffic at up to 1 Gbps. [IONOS](https://www.ionos.com/servers/vps)
- Scaleway includes egress in list prices. [Scaleway](https://www.scaleway.com/en/pricing/virtual-instances/)
- The netcup page says traffic is "included" but gives no figure. [netcup VPS](https://www.netcup.com/en/server/vps)

### Gaps
- The netcup traffic and throttle policy is not found in an official source.

## 4. k3s friendliness: networking, snapshots, storage, API, firewall

### Takeaway
Hetzner has the richest k3s ecosystem (API, Terraform, volumes, private networks, firewalls), but it is currently hard to buy. Netcup offers snapshots, a remote console and cheap local block storage, but has a weaker API and IaC ecosystem. OVH VPS includes daily backups. For a single node, none of these differences is decisive.

### Cited Findings
- netcup includes snapshots, a remote console, DDoS protection, and local block storage up to 8 TB at about €0.01–0.012/GB/mo. [netcup VPS](https://www.netcup.com/en/server/vps)
- OVH VPS includes a daily backup and offers premium 7-day backups. Monitoring, additional IPs, Load Balancer and managed DBs are not available in Local Zones. [OVH VPS](https://www.ovhcloud.com/en/vps/) OVH Rise dedicated includes a 1 Gbps private network. [OVH bare metal](https://www.ovhcloud.com/en/bare-metal/prices/)
- Hetzner leaves Volumes, Snapshots, Load Balancers, Object Storage and IPs out of the June 2026 price rise. [Northflank / search summary](https://northflank.com/blog/hetzner-cloud-server-price-increases)
- IONOS offers optional Cloud Backup from $0.065/GB/mo. [IONOS](https://www.ionos.com/servers/vps)

### Gaps
- I did not fetch Terraform provider or API docs, firewall feature sets, or kernel-module or nested-virtualisation details for netcup, OVH or IONOS. From general knowledge, netcup and OVH VPS are full KVM guests, so k3s and its kernel modules work; this is not verified with a 2026 source.

## 5. Reliability, support, and account verification for US customers

### Takeaway
netcup requires Stripe ID and selfie KYC and rejects some orders. Hetzner currently blocks new customers from creating cloud servers. Both are real onboarding hurdles for a new US account in October 2026.

### Cited Findings
- netcup uses Stripe identity verification, comparing a face photo to an ID document, with a 14-day window. Rejection reasons include mismatched name, address or date of birth and "geographical restrictions". [netcup helpcenter](https://www.netcup.com/en/helpcenter/documentation/general/identity-verification)
- User reports of rejected orders exist: a 2024 netcup forum thread and a Mastodon post about a name mismatch. [netcup forum](https://forum.netcup.de/thread/19265-we-have-to-reject-your-order/); [Mastodon](https://social.jsteuernagel.de/@jana/112495578848898574)
- An unofficial guide claims prepayment can bypass KYC. This is unverified. [netcup.best](https://netcup.best/blog/how_to_pass_netcup_kys_verification/)
- Hetzner's capacity restriction specifically hits new customers, and existing servers keep running. [Hetzner status](https://status.hetzner.com/incident/0a75c7ae-3377-41dc-aabe-601063724d24); a third-party writeup covers the dedicated-capacity crunch in August 2026. [bex.co](https://bex.co/blog/2026/08/19/hetzner-capacity-crunch-owning-hardware-when-provider-says-no-stock)
- OVH Kimsufi and Rise servers showed "Soon available", meaning out of stock, on 2026-10-15. [Kimsufi](https://eco.ovhcloud.com/en/kimsufi/); [OVH bare metal](https://www.ovhcloud.com/en/bare-metal/prices/)
- OVHcloud US averages 64 s to provision a VPS, based on 6 creations. [VPSBenchmarks](https://www.vpsbenchmarks.com/compare/ovhcloud_us)

### Inferences
- The 2026 hardware and RAM supply crunch is visible everywhere: Hetzner's restrictions, OVH's out-of-stock dedicated servers, and netcup's G12.5 storage halving. A buyer should check stock at their chosen location before committing to a provider.

### Gaps
- No 2025–2026 data on support response times or uptime incidents per provider.
- Hetzner's US account verification hurdles in 2026 are not researched; it historically requires ID or prepayment for some sign-ups.

## 6. ToS restrictions on sustained CPU use

### Takeaway
Only netcup has a sourced, though secondhand, note that sustained 100% CPU on a shared VPS gets throttled. Hetzner directs constant high-CPU workloads to dedicated-vCPU CCX. A coding-agent duty cycle is unlikely to trigger either.

### Cited Findings
- netcup VPS vCores are shared, and sustained 100% CPU (miners, constant encoders, always-busy CI) attracts throttling. [Valebyte, Jul 2026](https://valebyte.com/en/blog/netcup-review-2026-the-price-performance-king-and-its-fine-print/)
- Hetzner positions shared plans for "low to medium CPU usage" and CCX for "constant high CPU usage". [Hetzner cloud](https://www.hetzner.com/cloud)

### Gaps
- I did not find the official fair-use or AUP text for netcup, OVH or IONOS regarding CPU.
