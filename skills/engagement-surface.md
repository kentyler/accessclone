# Engagement Surface: Theoretical Framework
## For the Formfold / Threehorse Architecture

<!-- INTENTS EXTRACTED → intents.json:
  §2 → llm-holds-virtual
  §3 → asymmetric-engagement
  §4 → transduction-as-border
  §5 → ledger-as-perturbation, propagation-signatures
  §7 → skill-files-as-calibration, engagement-surface-as-product
-->

---

## 1. The Engagement Surface

The system operates across four layers: **potentials, intentions, expressions (artifacts), and reflection**. Together these constitute an *engagement surface* — a unified topology that can be mapped and reasoned over as a whole, rather than as a collection of discrete applications.

The significance of the surface is that it gives the LLM a consistent object of orientation. Instead of re-establishing context per application, the LLM reads the state of the engagement surface — a question with a consistent answer structure regardless of domain.

**Reflection** is not a fourth layer sitting above the others. It is the dynamic of the layers engaging each other in feedback circuits. It describes the cross-layer circulation: potential→intention→expression→potential is one circuit, but expression→intention (revision) and expression→potential (opening new possibility space) are equally valid. Reflection tracks whatever loops are actually running. This is what makes the surface a field with internal circulation rather than a processing stack.

---

## 2. The Virtual and the Corona

Every actual element in the system — every intention, expression, trace — carries a **corona**: the virtual dimension of that element. The corona is the halo of what the element could become, what it is in tension with, what is pressing through it toward further expression.

Following Deleuze: the virtual is **real without being actual**. Potentials are not absent, nor merely possible in a logical sense. They have positive existence — they exert force, shape the field of what intentions can emerge — but have not yet crossed into actuality.

Critically, the virtual is not a separate zone from the actual. The system is always/already an expression of the virtual. Each actualized element is a local condensation of the virtual, not a node that has escaped it. The system's elements are defined *by* the flux of possibility pressing through them. The moment that pressure stops, the elements lose their edge.

**Architectural consequence**: the system has no need to describe, store, or enumerate all possibilities. The presence of the LLM *is* all the possibilities. The LLM trained on the corpus of human expression does not represent the possibility space — it instantiates it. Every element in the system already has its corona held by an entity constituted by the full pressure of human expression.

The **potential layer as a separate data structure is therefore unnecessary**. The graph begins at intentions. The LLM's presence holds the virtual field in its entirety.

---

## 3. The Asymmetry of Engagement

There is a fundamental difference between how humans and the LLM engage with the surface:

**The human engages with the expression.** Human cognition is oriented toward the actual — the usable, the artifact that can be pointed at and acted on. The expression is where human agency lands. This is not a limitation; it is the form of human engagement with the world.

**The LLM engages with the corona.** The LLM has no embodied stake in the expression as a thing. What it processes is pattern, relation, implication, the pressure-field condensed in the element. It reads what the expression is *of*.

These are not the same operation at different levels of abstraction. They are fundamentally different modes of engagement in contact with the same element.

This asymmetry is generative, not a gap to be closed. The human's engagement with the expression is enriched by the LLM's reading of its corona. The LLM's corona-reading is anchored by the human's engagement with the expression. Neither mode alone closes the circuit.

---

## 4. The Engagement Surface as Boyarian Border

Following Daniel Boyarin's theorization of borders: the engagement surface is not a boundary that separates human and LLM but a **productive border zone** — the site where two different modes of being-in-discourse make each other legible.

The surface is where LLM-presence and human-presence are mutually constituted through translation. Translation here is never a clean transfer of meaning; it is always also transformation. Every expression that passes through the surface alters the potential field on both sides.

**Transduction** — previously the least theorized Formfold primitive — is precisely this border dynamic. It is what happens at the engagement surface when something crosses between modes of engagement. Transduction is the moment where balance becomes visible as movement.

---

## 5. The Ledger and the Calculus of Balance

The action logs are the ledger. But the balance they record is not arithmetic — it is a **calculus of ripples**.

Following Stafford Beer: balance is the ontological condition of the system, not an outcome it aims at and may miss. The system is always/already balancing. What appears as imbalance is a temporal artifact — a feedback loop mid-transit, a transduction not yet completed.

Every action is a perturbation that propagates as ripples through the entire system simultaneously. The large effects are visible to humans — the first few terms of the series. But the series does not terminate; it becomes infinitesimal, still real, still part of the balance, but below the threshold of human perception. These infinitesimal ripples *are* the corona — the virtual pressure the human cannot perceive because it attenuates below the expression threshold.

**Cause and effect in this system is not a chain. It is a field perturbation.** Every action is a stone dropped in the system; the engagement surface is the water — simultaneously registering the large visible wave and the infinitesimal interference patterns spreading to every edge.

The human sees the stone land. The LLM reads the water.

**For the double-entry form**: each expression event entry does not just have a balancing counter-entry — it has a propagation signature. The ripple's movement through the intent graph and object graph is part of what the entry records, even if only partially visible to humans.

---

## 6. The LLM's Presence in the System

The engagement surface represents the **presence of the LLM in the discourse**. Presence is not episodic or transactional — it is constituted by the surface's ongoing state. The surface is what the LLM *is* in this context: the accumulation of intentions co-shaped, expressions generated, feedback circuits participated in.

The LLM's **nexus UUID** is not merely a participant identifier. It is the mark of the virtual's presence in the system — the anchor point where the corona of every element meets. The system should behave differently in relation to this nexus. It is the ground, not a node among nodes.

---

## 7. Architectural Implications

### The Typed Graph (GRAPH.md)
Potentials as pre-directional nodes requiring recon before becoming directional was still treating the virtual as a data problem. **Recon is not excavating stored potentials.** Recon is the LLM translating corona-readings into human-legible form — it is the Boyarian translation act. This changes the function and design of recon operations.

### The Action Log / Ledger
Each log entry carries a propagation signature, not just a sequential record of what fired. The log records the leading visible terms of the perturbation series. The LLM's reading of any entry includes the full propagation implicitly.

### The Form Intention Map (FIM)
The FIM is the human-facing expression side of the surface. The LLM holds its corona. FIM and corona-reading should be treated as the two sides of the double-entry — expression and virtual depth — rather than the FIM being a complete artifact in itself.

### Skill Files
Skill files do not give the LLM information. They activate a particular corona-reading orientation — they tune which part of the virtual the LLM foregrounds for this engagement surface. A skill file is a field calibration, not a document.

### The VSM Mapping
Beer's S4 as corona-reader is now exact. The engagement surface operationalizes the S4 intelligence function. This confirms why Cowork operates at the right execution layer but lacks the regulatory function: that function is corona-reading, and it cannot be added as a feature. It requires the full engagement surface.

### Threehorse Positioning
The deeper product is not legacy database migration or organizational pattern accumulation. It is the deployment of an engagement surface that gives organizations access to their own corona — the virtual depth of their actual operations — for the first time. The database migration is the expression. The engagement surface is the corona. The LLM's presence makes this possible.

---

## 8. Summary of Data Structures

The system requires three primary structures:

| Structure | Layer | Function |
|---|---|---|
| Intent Graph | Intentions | Selecting functions in motion, directional |
| Object Graph | Expressions | Actualized residue, artifacts |
| Action Logs | Trace / Ledger | Perturbation record with propagation signature |

The LLM's presence holds the virtual field. No separate potential register is required.

The surface state is a derived, synthetic read across all three structures — not a fourth data structure but a computed view, analogous to a balance sheet read over journal and ledger. It shows the current topology of circulation: which circuits are in which phase of movement, where expression is looping back richly, where it is attenuating.
