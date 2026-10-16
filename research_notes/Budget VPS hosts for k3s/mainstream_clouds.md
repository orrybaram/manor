# Mainstream developer clouds as a premium baseline vs Contabo (as of 2026-10-15)

Scope: Vultr, Akamai/Linode, DigitalOcean (Droplets + DOKS), Oracle Cloud (Always Free + PAYG flex), AWS Lightsail (briefly). The target is a single-node k3s cluster or a managed k8s cluster running 3–8 coding-agent pods (1 CPU/2GiB to 2 CPU/4GiB each, 20Gi PVC each), with an ideal node of about 8–16 vCPU and 16–64 GB RAM.

Method notes:
- Vultr and Linode prices come from their **public, unauthenticated pricing APIs**, fetched 2026-10-15: `https://api.vultr.com/v2/plans` and `https://api.linode.com/v4/linode/types`, `/v4/lke/types`, `/v4/volumes/types`, `/v4/network-transfer/prices`. These are the same data the official price pages render. vultr.com/pricing returned HTTP 403 to the fetcher, and akamai.com/cloud/pricing did not list per-plan numbers.
- Oracle prices come from Oracle's public price-list API, `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD`, with `lastUpdated` 2026-10-08. oracle.com/cloud/compute/pricing returned 403.
- DigitalOcean and Lightsail prices come from their official pricing pages, fetched 2026-10-15.
- "Monthly" for hourly-only items = hourly × 730 h (my arithmetic).

---

## 1. Prices: VMs at 4/8/16 vCPU and 8–64 GB, managed k8s control plane, block storage, IPv4, egress

### Takeaway
At the target size (8 vCPU/32 GB or 16 vCPU/64 GB), mainstream shared-CPU VMs cost about **$160–$192/mo for 8c/32GB** and **$320–$384/mo for 16c/64GB**. Dedicated CPU costs about **$240–$252/mo (8c/32GB)** and **$480–$504/mo (16c/64GB)**. That is roughly 4–10× Contabo's price for similar nominal specs. Oracle PAYG Ampere A1 is the only mainstream option near budget-host pricing, at about **$83/mo for 8 OCPU/48 GB after the free allowance**. Managed k8s control planes are free at Vultr, Linode and DO in their non-HA tiers. Block storage is a uniform $0.10/GB-mo everywhere except Oracle (~$0.0425/GB-mo balanced).

### Cited Findings

**Vultr** (plans API, 2026-10-15; `monthly_cost` field)
- Regular Cloud Compute (`vc2`, shared): 4 vCPU/8 GB/160 GB/4 TB transfer **$40**; 6 vCPU/16 GB/320 GB/5 TB **$80**; 8 vCPU/32 GB/640 GB/6 TB **$160**; 16 vCPU/64 GB/1280 GB/10 TB **$320**. That works out to $5/GB RAM, or $10–20 per vCPU. — [Vultr plans API](https://api.vultr.com/v2/plans)
- High Performance (`vhp`, shared AMD EPYC or Intel, NVMe): 4c/8GB **$48**; 4c/12GB **$72**; 8c/16GB/350 GB/8 TB **$96**; 12c/24GB/500 GB/12 TB **$144**. There is no vhp plan above 24 GB. — [Vultr plans API](https://api.vultr.com/v2/plans)
- High Frequency (`vhf`, shared): 4c/16GB **$96**; 8c/32GB/512 GB/7 TB **$192**; 12c/48GB **$256**; 16c/58GB **$320**. — [Vultr plans API](https://api.vultr.com/v2/plans)
- Optimized Cloud (`voc`, dedicated vCPU):
  - General Purpose: 4c/16GB **$120**; 8c/32GB/160 GB/7 TB **$240**; 16c/64GB/320 GB/8 TB **$480**.
  - CPU-optimized: 8c/16GB **$160**; 16c/32GB **$320**.
  - Memory-optimized: 8c/64GB **$320**.
  - Source: [Vultr plans API](https://api.vultr.com/v2/plans). A third-party aggregator independently lists voc-g-8c-32gb at $0.3288/h, or $240/mo — [SpendArk, prices checked Jul 2026](https://spendark.com/instances/voc-g-8c-32gb/)
- VX1 (newer line, boot disk on block storage, only 9–12 locations): g-4c-16g **$87.60**; g-8c-32g **$175.20** (no local disk) or **$223.38** with 480 GB; g-16c-64g **$350.40** or **$446.76** with 960 GB. — [Vultr plans API](https://api.vultr.com/v2/plans)
- VKE control plane: "fully-managed control plane at no additional cost". You pay only for worker nodes, load balancers and block storage. The page does not mention HA control-plane pricing. — [Vultr docs, updated 2026-04-15](https://docs.vultr.com/support/products/vke/how-much-does-the-vultr-kubernetes-engine-cost)
- Block storage is $0.10/GB-mo. The NVMe performance upgrade kept "the same $0.10/GB/month price", at 10,000 IOPS and 400 MB/s per volume. — [Vultr blog](https://blogs.vultr.com/block-storage-upgraded); [Vultr Block Storage product page](https://www.vultr.com/products/block-storage/)
- Bandwidth overage is $0.01/GB — [Vultr docs: overage rate](https://docs.vultr.com/support/platform/billing/what-is-the-bandwidth-overage-rate). The Cloud Compute product page conflicts with this, citing regional rates of $0.03/GB (Singapore/Tokyo) and $0.05/GB elsewhere — [Vultr Cloud Compute page](https://www.vultr.com/products/cloud-compute/). Every plan includes 4–10 TB of transfer (see the plans API above).
- IPv4: no separate IPv4 charge was found; one IPv4 address is bundled with the plan (not separately verified for 2026).

**Akamai / Linode** (types API, 2026-10-15; US-region prices; Jakarta and São Paulo are about 20–40% higher)
- Shared CPU: 4c/8GB/160 GB/5 TB **$48**; 6c/16GB/320 GB/8 TB **$96**; 8c/32GB/640 GB/16 TB **$192**; 16c/64GB/1280 GB/20 TB **$384**. That is $6/GB RAM. — [Linode types API](https://api.linode.com/v4/linode/types)
- Dedicated CPU (G6): 4c/8GB **$72**; 8c/16GB/6 TB **$144**; 16c/32GB/7 TB **$288**. — [Linode types API](https://api.linode.com/v4/linode/types)
- Dedicated G7 / Premium (newer AMD): 4c/8GB **$86**; 8c/16GB **$173**; 16c/32GB **$346**. — [Linode types API](https://api.linode.com/v4/linode/types)
- Dedicated G8 (hourly only, **0 bundled transfer**):
  - 8c/16GB $0.27/h (≈$197/mo)
  - 8c/32GB $0.42/h (≈$307/mo)
  - 16c/32GB $0.54/h (≈$394/mo)
  - 16c/64GB $0.84/h (≈$613/mo)
  - Source: [Linode types API](https://api.linode.com/v4/linode/types). The pricing page confirms that "G8 and GPU plans include no bundled transfer" — [Akamai cloud pricing](https://www.akamai.com/cloud/pricing)
- LKE control plane: Standard **$0**; HA **$60/mo** ($0.09/h); LKE Enterprise **$300/mo** ($0.45/h). — [Linode LKE types API](https://api.linode.com/v4/lke/types)
- Block storage volumes are **$0.10/GB-mo** (US). — [Linode volume types API](https://api.linode.com/v4/volumes/types)
- Network transfer overage is **$0.005/GB**. "Distributed" transfer is $0.01/GB. — [Linode network-transfer prices API](https://api.linode.com/v4/network-transfer/prices)
- Backups add-on: $20/mo for the 16 GB plans; $40/mo for the 32 GB shared and 16c dedicated plans. — [Linode types API addons](https://api.linode.com/v4/linode/types)
- Akamai Managed Service costs $100 per instance per month. — [Akamai cloud pricing](https://www.akamai.com/cloud/pricing)

**DigitalOcean** (official Droplet pricing page, fetched 2026-10-15)
- Basic (shared): 4 vCPU/8 GiB/160 GiB/5,000 GiB transfer **$48**; 8 vCPU/16 GiB/320 GiB/6,000 GiB **$96**. That is the largest Basic plan in the target range. — [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- CPU-Optimized (dedicated, 2 GB per vCPU): 4/8 **$84**; 8/16 **$168**; 16/32 **$336**; 32/64 **$672**. — [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- General Purpose (dedicated, 4 GB per vCPU): 4/16 **$126**; 8/32 **$252**; 16/64 **$504**. — [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- Billing has been per-second since 2026-01-01, with a 60 s or $0.01 minimum. "v5 Droplets" are priced per configured resource, and their public IPv4 line item is "$0.00/hour, subject to change". — [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- The fetched text did not show Premium AMD/Intel Basic prices, even though the page has a Premium tab. — [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets)
- DOKS: control plane free; HA control plane **$40/mo**. Nodes cost the same as Droplets. Load balancer from $12/mo. Overage is **$0.01/GiB** beyond the pooled allowance, inbound transfer is free, and transfer allowances are pooled across nodes. — [DO Kubernetes pricing](https://www.digitalocean.com/pricing/kubernetes)
- Volumes cost **$0.10/GiB-mo** and volume snapshots **$0.06/GiB-mo**. — [DO Volumes pricing](https://www.digitalocean.com/pricing/volumes)

**Oracle Cloud PAYG** (price list API, lastUpdated 2026-10-08). An A1 OCPU is one Arm core. An x86 (E5/E6) OCPU is one physical core, which is 2 vCPUs.
- Ampere **A1** Flex: **$0.01/OCPU-h** and **$0.0015/GB-h**, after a free tier of 3,000 OCPU-h and 18,000 GB-h shown in the same price list. — [OCI price list API, parts B93297/B93298](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
  - My arithmetic: 8 OCPU/48 GB = $58.40 + $52.56 = **$110.96/mo** before free usage. After the 2 OCPU/12 GB free allowance it is about **$83/mo**; with the older 4 OCPU/24 GB allowance it is about $55/mo.
- **A2** Flex (AmpereOne): $0.014/OCPU-h and $0.002/GB-h. **A4** Flex: $0.0138/OCPU-h and $0.0027/GB-h. — [OCI price list API, B109529/30, B112145/46](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
- **E5 and E6** Standard Flex (AMD): $0.03/OCPU-h and $0.002/GB-h. **E4**: $0.025/OCPU-h and $0.0015/GB-h. — [OCI price list API, B97384/85, B111129/30, B93113/14](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
  - My arithmetic: E5 with 8 OCPU (16 vCPU) and 64 GB = $175.20 + $93.44 = **≈$269/mo**. E5 with 4 OCPU (8 vCPU) and 32 GB ≈ **$134/mo**.
- Block volume: $0.0255/GB-mo storage plus $0.0017 per VPU/GB-mo. Balanced = 10 VPU, so ≈ **$0.0425/GB-mo** (my arithmetic). 200 GB is free. — [OCI price list API, B91961/B91962/B91445](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
- Egress from North America/EU: **first 10 TB/mo free**, then **$0.0085/GB**. — [OCI price list API, B88327](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
- OKE: **Enhanced Cluster $0.10/cluster-hour (≈$73/mo)**; virtual nodes $0.015/node-hour. The price list has no Basic-cluster line item, which is consistent with Basic clusters having a free control plane. — [OCI price list API, B96545/B96109](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
- One Always Free flexible load balancer (10 Mbps) is included. The paid LB base is free for the first 744 h, then $0.0113/h. — [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm); [OCI price list API, B93030](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)

**AWS Lightsail** (official pricing page, fetched 2026-10-15)
- General Purpose:
  - 4 vCPU/16 GB/320 GB/6 TB: **$84** with IPv4 ($80 IPv6-only)
  - 8 vCPU/32 GB/640 GB/7 TB: **$164** ($160 IPv6-only)
- Compute Optimized: 4/8 **$84**; 8/16 **$168**.
- Memory Optimized: 4/32 **$144**; 8/64 **$294**.
- Block storage is **$0.10/GB-mo**. Overage is **$0.09/GB**, about 9× DO/Vultr. Lightsail has no managed Kubernetes product; the page lists container services only, at up to 4 vCPU/8 GB for $160.
- Source: [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)

**Comparison anchor**: on the same aggregator, Hetzner CCX33 (8 dedicated/32 GB) is listed at $162.99/mo, DO 8c/32GB at $252 and Azure D8s_v5 at $280.32. — [SpendArk comparison, Jul 2026](https://spendark.com/compare/ccx33-vs-voc-g-8c-32gb/)

### Inferences
- **Cheapest mainstream fit for 8 agents** at 2 CPU/4 GiB each (16 vCPU/32 GiB requested): Vultr `vc2-16c-64gb` at $320, Linode Shared 16c/64GB at $384, or DO CPU-Opt 16/32 at $336 (dedicated).
- **Cheapest mainstream fit for 3–4 agents**: Vultr `vc2-8c-32gb` at $160, `vhp-8c-16gb` at $96, or DO Basic 8/16 at $96.
- **Per-vCPU cost**: shared-CPU mainstream is about $10–24/vCPU-mo, dedicated about $18–31/vCPU-mo. Oracle A1 PAYG is $7.30/OCPU-mo plus $1.10/GB-mo, the cheapest by far.
- **PVC cost**: 8 PVCs × 20 Gi = 160 GB of block storage costs about $16/mo on Vultr, Linode, DO or Lightsail. With k3s's local-path provisioner on the node's bundled SSD, the extra cost is zero; the bundled disks (160–1280 GB) are large enough.
- **Egress** is a non-issue for git clones (mostly ingress) and Claude API traffic. Every provider bundles 4–20 TB, except Linode G8 (0 TB).

### Gaps
- Vultr's HA control-plane pricing for VKE could not be confirmed (official doc silent).
- DO Premium Intel/AMD Basic Droplet prices did not render in fetch.
- DO Droplet backup pricing (historically 20%/30% of the Droplet price, weekly/daily) and Reserved IP pricing were not verified in 2026 sources.
- No official 2026 source was found for IPv4 surcharges at Vultr or Linode; IPv4 appears to be bundled.

---

## 2. Benchmark / performance consistency vs budget hosts

### Takeaway
Mainstream providers score higher on **stability, disk and network**. Contabo scores well on **raw CPU per dollar** but poorly on stability: one 2026 Contabo plan got an F (0.8/20) for stability on vpsbenchmarks. For CPU-heavy compile bursts from several agents at once, dedicated-vCPU tiers (Vultr VOC/VX1, Linode Dedicated, DO CPU-Opt/GP) are the "consistent" premium option.

### Cited Findings
- vpsbenchmarks.com grades, scored /20:
  - **Contabo** Cloud VPS 18 (€49, trial Sep 08 2026): CPU B (14.7), **Stability F (0.8)**, Disk E (4.9), Network D (7.1).
  - **Contabo** Cloud VPS Plus 4 (€13.50, Jul 27 2026): CPU B (15.1), Stability C (12.4), Disk D (6.9).
  - **Contabo** Cloud VDS S (€49, Oct 08 2026): CPU C (10.5), Stability B (14.3), Network E (5.4).
  - **Vultr** VX1 GP 4C 16G 240S ($110.16, Oct 2025): all B (Web 15.2, CPU 12.8, Stability 15.2, Disk 15.9, Network 14.5).
  - **Vultr** VX1 GP 2C 8G 120S (Jun 2026): Stability A (17.1), Disk A (17.7).
  - **Vultr** Regular 8GB 4 cores ($40, Apr 30 2026): CPU E (5.6), Disk E (3.8), Stability C (11.8).
  - **Vultr** High Performance 8GB ($48, Mar 2026): CPU C (11.2), Stability B (13.8).
  - Consistency score: Contabo 56, Vultr 63 (>65 = highly consistent).
  - Source: [vpsbenchmarks Contabo vs Vultr](https://www.vpsbenchmarks.com/compare/contabo_vs_vultr)
- A secondary site reported a 6-month test of Contabo's 4 vCPU/8 GB plan with about 18% best-vs-worst-week variance, against under 5% for Vultr and DO. **Caveat**: its main benchmark page now says it "measures nothing" and that earlier results "were removed". Treat this as unreliable. — [bestusavps Contabo page](https://bestusavps.com/benchmarks/contabo/); [bestusavps benchmarks index](https://bestusavps.com/benchmarks/)
- At $24, DO Basic regular runs standard Intel Xeon with SSD, while Vultr High Performance runs AMD EPYC Genoa with NVMe. — [Better Stack Vultr review / DO vs Vultr, Mar 2026](https://betterstack.com/community/guides/web-servers/digitalocean-vs-vultr/)
- Further head-to-head pages exist but were not fetched: [vpsbenchmarks DO vs Linode vs Vultr](https://www.vpsbenchmarks.com/compare/digitalocean_vs_linode_vs_vultr); [vpsbenchmarks Contabo vs DO](https://vpsbenchmarks.com/compare/contabo_vs_docean)

### Inferences
- Vultr "Regular" (`vc2`) is the cheapest mainstream SKU but benchmarks no better than Contabo on CPU. The premium is mostly paid for network, support, API maturity and stability, not raw speed.
- For bursty compiles, a dedicated or high-performance SKU (Vultr vhp/VOC/VX1, Linode Dedicated/G7, DO CPU-Opt) is where a mainstream cloud clearly beats Contabo's oversold shared vCPUs.

### Gaps
- Fetched sources had no 2026 vpsbenchmarks data for Linode, DO or Oracle A1 at the 8–16 vCPU sizes.
- No 2026 steal-time measurements were found.

---

## 3. Oracle Always Free (2026 changes), OKE, idle reclamation, capacity, PAYG Ampere pricing

### Takeaway
The Always Free Ampere A1 allowance was cut from **4 OCPU/24 GB to 2 OCPU/12 GB (1,500 OCPU-h + 9,000 GB-h/mo), effective 2026-06-15**, with no announcement. Treatment of PAYG accounts is disputed, and Oracle's public price-list API still shows the old 3,000/18,000-hour free tiers as of 2026-10-08. Idle instances can still be reclaimed after 7 days below 20% utilization. "Out of host capacity" errors remain a documented risk. 2 OCPU/12 GB can fit only about 2–3 small agent pods, so it is not a fit for the target workload on free alone.

### Cited Findings
- Current docs: "All tenancies get the first 1,500 OCPU hours and 9,000 GB hours per month for free for VM instances using the VM.Standard.A1.Flex shape… For Always Free tenancies, this is equivalent to 2 OCPUs and 12 GB of memory." — [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- How the change landed:
  - It took effect 2026-06-15, down from 3,000/18,000 hours. There was no blog post, customer email or announcement; only the docs changed.
  - Free-only accounts had over-limit instances shut down until resized.
  - On 2026-06-22, support agents reportedly told PAYG users by email that PAYG could keep 4 OCPU/24 GB free. Oracle has not publicly clarified this.
  - Oracle's fine print: "If an existing resource is terminated, it may not be possible to recreate resources above the updated Always Free limit."
  - Source: [InfoQ, 2026-07-03](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)
- Other reports say Oracle emailed users to cut usage by **2026-08-18** or face termination. — [cnelecar blog](https://www.cnelecar.com/blog/oracle-always-free-arm-limits-cut-2026/); see also [Linuxiac](https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/), [terminalbytes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/), [Oracle Customer Connect thread](https://community.oracle.com/customerconnect/discussion/970310/oci-always-free-updated-ampere-a1-compute-allocation)
- **Conflict**: Oracle's public price-list API (lastUpdated 2026-10-08) still shows A1 OCPU $0 for 0–3,000 h, then $0.01, and A1 memory $0 for 0–18,000 GB-h, then $0.0015. That matches the *old* 4 OCPU/24 GB allowance, which may reflect the PAYG grandfathering or a stale price list. — [OCI price list API](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
- Idle reclamation: Always Free instances are deemed idle if, over 7 days, 95th-percentile CPU < 20%, network < 20%, and memory < 20% (memory test is A1 only). — [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- Capacity: "'out of host capacity' error… indicates a temporary lack of Always Free shapes in your home region. Try… a different availability domain, or wait." — [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- Other Always Free resources:
  - 200 GB total block volume (boot + data) and 5 backups. The minimum boot volume is 47–50 GB.
  - 2× VM.Standard.E2.1.Micro (1/8 OCPU, 1 GB).
  - 1 flexible LB at 10 Mbps.
  - Source: [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- After upgrading to PAYG, "Oracle doesn't charge for Always Free resources… and will only charge you for resource usage above the Always Free limits." — [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- OKE Enhanced Cluster is $0.10/h; there is no Basic-cluster SKU (Basic is free); virtual nodes are $0.015/h. — [OCI price list API](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)
- PAYG prices: A1 is $0.01/OCPU-h + $0.0015/GB-h; A2 is $0.014 + $0.002; A4 is $0.0138 + $0.0027. — [OCI price list API](https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD)

### Inferences
- A PAYG A1 node at 8 OCPU/48 GB costs about $83/mo after the 2 OCPU/12 GB free credit, or about $55/mo if the old 4/24 credit still applies to PAYG.
- A 16 OCPU/96 GB A1 node is about $194/mo before credits (my arithmetic).
- That makes PAYG A1 price-competitive with Contabo, while adding the 10 TB free egress and free OKE Basic.
- **Arm caveat**: Claude Code and Node run on arm64, but any agent toolchains, Docker images or prebuilt binaries in cloned repos need arm64 builds. This is a real compatibility risk for "compile arbitrary repos" workloads.
- On a PAYG account, a busy agent node is unlikely to hit the idle-reclamation thresholds. Free-only accounts with idle agent pods could get reclaimed.

### Gaps
- No official Oracle statement was found resolving whether PAYG tenancies keep 4/24 free.
- No 2026 data was found on A1 capacity availability in specific US regions (Ashburn, Phoenix, San Jose).
- I did not find whether the idle-reclamation policy applies to PAYG; the docs text frames it for Always Free instances.

---

## 4. Reliability, support, k3s ease, snapshots/backups, private networking, autoscaling

### Takeaway
All four mainstream providers offer API- and Terraform-driven provisioning, snapshots, private VPC networking, free (non-HA) managed k8s control planes, and cluster autoscaler support in their managed k8s. k3s on a single VM is trivial on any of them. The main differentiators are an HA control-plane add-on (DO $40, Linode $60) and Linode's cheaper transfer overage ($0.005/GB).

### Cited Findings
- **DOKS**: free control plane; HA is $40/mo; nodes priced as Droplets; transfer pooled across nodes; internal transfer free. Volume snapshots are $0.06/GiB-mo. — [DO Kubernetes pricing](https://www.digitalocean.com/pricing/kubernetes); [DO Volumes pricing](https://www.digitalocean.com/pricing/volumes)
- **LKE**: Standard free, HA $60/mo, Enterprise $300/mo. "No per-cluster fee… HA/dedicated control plane paid only when needed." Backups add-on is $20–40/mo at the target sizes. — [Linode LKE API](https://api.linode.com/v4/lke/types); [Akamai cloud pricing](https://www.akamai.com/cloud/pricing)
- **VKE**: free managed control plane; you pay for workers, LBs and block storage. — [Vultr docs](https://docs.vultr.com/support/products/vke/how-much-does-the-vultr-kubernetes-engine-cost)
- Lightsail has no managed k8s; container services top out at 4 vCPU/8 GB. — [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)
- Provisioning time: Vultr averages 80 s (12 samples) and Contabo 60 s (3 samples). — [vpsbenchmarks Contabo vs Vultr](https://www.vpsbenchmarks.com/compare/contabo_vs_vultr)

### Inferences
- For 3–8 agent pods, single-node k3s on one VM avoids LB and HA costs entirely. Managed k8s adds value mainly for node autoscaling, for example scaling to zero worker nodes overnight.
- Hourly or per-second billing (DO per-second since 2026-01) makes ephemeral burst nodes viable on mainstream clouds. Contabo, which bills monthly, cannot do this.

### Gaps
- Not verified in this pass: 2026 SLA percentages, support tiers and prices, and DO's Droplet backup percentage.
- No dated 2026 Reddit or review reliability data was gathered.

---

## 5. Free credits / startup programs

### Takeaway
New-account credits are modest: about $100–200 for 60 days at DO, and roughly $100 at Linode and Vultr via referral links (unverified for 2026). Oracle's Always Free tier is the only durable free compute. Startup programs, such as DO Hatch, could offset months of a premium node, but 2026 terms were not verified.

### Cited Findings
- DigitalOcean's own trial page offers "free credit up to $100… within 60 days". Third-party guides cite $200 for 60 days via partner links. — [DO trial page](https://try.digitalocean.com/more-vcpus); [devopscube](https://devopscube.com/get-free-digital-ocean-credits/)
- Vultr $100 and Linode $100 via referral links, per an undated list. — [linuxhandbook](https://linuxhandbook.com/free-linux-cloud-servers)
- Lightsail: "start free through the AWS Free Tier" (allowances not listed on the page). — [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)

### Gaps
- Not verified for 2026: Oracle's $300/30-day trial credit, the terms of DO Hatch, Vultr's startup program and Akamai's startup program, and current Vultr/Linode signup-credit amounts.
