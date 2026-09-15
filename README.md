# Decay (DK)

Decay (DK) is a lightweight scripting language focused on intent: turning ideas into working logic without the friction of rigid boilerplate, curly braces, or semicolons.

Decay bakes **AI as Code** directly into the grammar, making it just as easy to find optimal solutions, evaluate fuzzy conditions, or run a local model as it is to use `if`, `while`, or `switch`.

### Core Principles

* **Low-Noise Syntax:** Stripping away curly braces, semicolons, and mandatory indentation keeps code visually clear and token-lean. Use compact shorthands like `@` for quick exits, or stick with familiar keywords like `return`. DK adapts to your flow so you can write what you're thinking.

* **Human-Intuitive Collections:** Lists count from `1` by default to match how people naturally think, while still offering seamless zero-based access when interfacing with external systems.

* **Native Machine Intelligence:** Complex problem-solving lives right in the language syntax. You can explore permutations, classify dynamic patterns, and run local models without setting up web services, runtime wrappers, or complex dependencies.

* **Operational Simplicity:** Runs immediately as a self-contained desktop executable with no dependencies to install, or embeds directly into any web browser with a single script tag.

---

## Quick Tour

```dk
~ This is a comment. This is how you write comments in DK.

~ You can add the 'function' keyword, but DK doesn't require it and we won't show it again.
function generateGreetings():
    ~ Collections default to 1-based indexing, matching how people naturally count
    recipients = ["World", "Developer", "Agent"]

    ~ Variables don't use keywords like 'var', 'let', or 'const'—they just exist when assigned
    greetingText = ""

    ~ Loops iterate across ranges using '..'. All blocks close cleanly with '#'
    for i = 1..3
        name = recipients[i]

        ~ Conditionals need no parentheses around conditions; blocks terminate with '#'
        if name == "World"
            greetingText += "Hello, World!\n"
        else
            greetingText += "Welcome to Decay, " + name + "!\n"
        #
    #

~ Exit and return a value with '@' (you can also use the 'return' keyword)
@ greetingText

~ Call the function and print the returned string
print generateGreetings()
```

Output:

```text
Hello, World!
Welcome to Decay, Developer!
Welcome to Decay, Agent!
```

## Table of Contents

* [Getting Started](#getting-started)
* [AI as Code Primitives](#ai-as-code-primitives)
  * [1. Constraint Satisfaction (`solver`)](#1-constraint-satisfaction-solver)
  * [2. Pattern Classification (`neural`)](#2-pattern-classification-neural)
  * [3. Local Model Inference (`brain`)](#3-local-model-inference-brain)
* [Language Essentials](#language-essentials)
  * [Functions & Single-Return Architecture](#functions--single-return-architecture)
  * [Arrays, Maps, and Rebasing](#arrays-maps-and-rebasing)
  * [Classes & Sigils](#classes--sigils)
* [Canonical Forms](#canonical-forms)

---

## Getting Started

### CLI & Binary Execution
Run `.dk` script files or start an interactive REPL using the standalone binary:

```bash
~ Launch interactive REPL
DK.exe

~ Execute an external script
DK.exe run script.dk
```

### Web Usage
Decay compiles and runs entirely client-side in the browser—no server backend, Node.js installation, or container environment required.

Interactive Online Playground: Write and run Decay code directly in your browser with real-time output and syntax minification:

    https://d-e-c-a-y.github.io/Decay/

Drop-In Embed (dk.min.js): Add the self-contained virtual machine to any website or web application with a single script tag:

```html
<script src="dk.min.js"></script>
<script>
// Execute Decay scripts directly on the client
Decay.run(
   recipients = ["Web", "Agent", "World"]
    for i 1..3
        print "Hello, " + recipients[i] + "!"
    #
);
</script>    
```

---

## AI as Code Primitives

DK treats machine intelligence as a core syntactic category:

### 1. Constraint Satisfaction (`solver`)

Declare variable domains, non-negotiable invariants (`rules`), soft rankings (`prefer`), and optimization metrics (`optimize`). The Decay runtime traverses the domain space, prunes invalid permutations early, and deterministically outputs the mathematically optimal solution.  

* **Domain Map:** Sets allowable values for each variable (e.g., [x: [1, 2, 3]]).  

* **Hard Invariants (rules):** Mandatory Boolean expressions; failing any rule instantly prunes the branch.  

* **Soft Preferences (prefer):** Desired criteria used to rank valid solutions without rejecting candidates.  

* **Optimization (optimize):** Directives ([max: expr], [min: expr]) that mathematically score and order answers.  

* **Search Bounds:** mode "first" or mode "all", combined with limit (max iterations tested) and timeout (wall-clock milliseconds).  

#### Solver Example: VIP Dinner Seating

Four guests require assigned seating (Seats 1–4). Writing imperative code to enforce unique seats alongside individual seating quirks would take multiple nested loops and rollback arrays. solver finds the single layout that satisfies every constraint:  

```dk
seating = solver
    [
        alice:   [1, 2, 3, 4],
        bob:     [1, 2, 3, 4],
        charlie: [1, 2, 3, 4],
        diana:   [1, 2, 3, 4]
    ]
    rules [
        ~ 1. Everyone must take a unique seat
        alice != bob, alice != charlie, alice != diana,
        bob != charlie, bob != diana,
        charlie != diana,

        ~ 2. Guest preferences
        charlie == 1,         ~ Charlie takes the window seat (Seat 1)
        alice == charlie + 1, ~ Alice insists on sitting next to Charlie
        bob % 2 == 0,         ~ Bob requires an even-numbered seat
        diana < bob           ~ Diana wants to sit before Bob
    ]
    mode "all"
#

print "Solved: " + seating.ok
print "Found {seating.count} valid layout(s)!"
print "Alice sits at seat:   " + seating.best.alice
print "Bob sits at seat:     " + seating.best.bob
print "Charlie sits at seat: " + seating.best.charlie
print "Diana sits at seat:   " + seating.best.diana

```

The output for this will show:

```text
    Solved: true
    Valid layouts found: 1
    Alice sits at seat:   2
    Bob sits at seat:     4
    Charlie sits at seat: 1
    Diana sits at seat:   3
```

### 2. Pattern Classification (`neural`)

In Decay, the `neural` block looks at the whole, multidimensional picture rather than forcing you to juggle individual variables. Instead of untangling a web of nested if/else branches to figure out whether someone is close enough, hurt enough, or aggressive enough, neural compares your live values against a table of ideal situations and picks whichever one fits best.  

* **Analog Closeness Over Rigid Equality:** Real-world inputs rarely land on clean, round numbers. neural scores how close your numbers are to each target row, so a player standing 4.8 meters away naturally triggers a 5-meter response without you having to write manual range brackets or rounding helpers.  

* **Confidence Quality Gates (limit):** Every match calculates a 0–100 confidence score. If the current situation doesn't match any pattern well enough to clear your threshold, the engine gracefully takes the fallback route instead of making a bad guess.

* **Selective Focus (any):** Not every decision cares about every stat. Dropping an any wildcard into a slot lets you ignore variables that aren't relevant for that specific move, so broad gut instincts and hyper-specific counterattacks can live side-by-side in the same block.  

* **Natural Behavior Blending:** Different rows can trigger the same action by using the same label. This lets you allow an attack fire easily when conditions are calm, while tightening the requirements to very specific openings once the pressure ramps up, for example.  


#### Neural Example: Boss Battle Action Choice

```dk
evaluateTactics(hp, dist, rage, pressure):
    tactics = neural boss_ai
        ~ 1. Continuous input vector: [Boss HP %, Player Distance (m), Boss Rage %, Inbound Pressure %]
        [hp, dist, rage, pressure]

        ~ 2. Overlapping Behavioral Archetypes
        [any,  5, any,  40] TailSwipe    ~ Close range, low-to-moderate combat tempo
        [any,  4,  30,  85] CounterParry ~ Close range under intense pressure
        [any,  6,  85,  80] BerserkSlam  ~ Close-mid range, high rage, aggressive exchange
        [ 20, any,  90, any] BloodNova    ~ Critical health desperation overdrive

        ~ 3. Live inputs & confidence gate
        WITH [hp, dist, rage, pressure]
        limit 75

        ~ 4. Action dispatch
        case TailSwipe    triggerSkill("TailSwipe")    ~ Whistling tail sweep to clear space
        case CounterParry triggerSkill("CounterParry") ~ Bracing shockwave to deflect assault
        case BerserkSlam  triggerSkill("BerserkSlam")  ~ Overhead smash punishing reckless offense
        case BloodNova    triggerSkill("BloodNova")    ~ Room-wide blood nova detonation
        fallback          triggerSkill("Defend")       ~ Circling player defensively
    #
@ tactics

triggerSkill(skill):
    ~ Trigger skill helper function - returns the triggered ability
@ "Triggered ability: " + skill 

~ Scenario A: Contested Melee (dist: 5.2m, high rage: 82%, high pressure: 76%)
climax = evaluateTactics(42, 5.2, 82, 76)
print "Contested Melee -> " + climax.last + " [" + round(climax.confidence) + "%]"
print climax.action

print "---"

~ Scenario B: Routine Spacing (dist: 4.8m, calm combat tempo: rage 25%, pressure 42%)
reset = evaluateTactics(55, 4.8, 25, 42)
print "Routine Spacing -> " + reset.last + " [" + round(reset.confidence) + "%]"
print reset.action
```

Output:
```text
    Contested Melee -> BerserkSlam [97%]
    Triggered ability: BerserkSlam

    Routine Spacing -> TailSwipe [99%]
    Triggered ability: TailSwipe
```


### 3. Local Model Inference (`brain`)

Integrating language models into software typically requires external infrastructure—spawning Python subprocesses, managing local Ollama HTTP services, or managing API wrappers. 
Brain enables local language models to be embedded directly into your code. Quantized JSON and GGUF model weights execute locally, exposing token usage, confidence scores, classification labels, and conversation history as inspectable object properties. 

* **Core Mechanics:Weight & Vocab Ingestion (`use`):** Declares the local weights file and tokenizer vocabulary.  

* **Contextual Memory (`memory true`):** Persists conversation history across repeated calls sharing the same session signature, eliminating manual prompt re-stitching.  

* **Sampling Controls (sample, limit, stop):** Configures runtime limits and sampling parameters directly in syntax. `limit` caps the total tokens generated, `stop` halts emission the moment specific delimiter strings appear, and `sample` configures creativity and determinism via parameters like `temp`, `top_k`, `penalty`, and `seed`.  

* **Return Object Introspection:** Returns .label, .confidence, .tokens, and .text to verify why a response was generated rather than treating inference as an opaque text dump.


#### Brain Example: Player Choice Evaluation

```dk
guardEncounter(playerInput):
    guard = brain
        use weights "models/guard_triage.json"
        use vocab "models/vocab.json"
        limit 16
        memory true
        prompt playerInput
    #
@ guard

~ Turn 1: Player makes a standard entry request
turn1 = guardEncounter("Merchant convoy arriving to sell dried fruits.")
print "Player:      'Merchant convoy arriving to sell dried fruits.'"
print "State Label:  " + turn1.label
print "Confidence:   " + turn1.confidence + "%"
print "Guard:       '" + turn1.text + "'"
print "---"

~ Turn 2: Player attempts a bribe; context carries forward via memory
turn2 = guardEncounter("I lost my papers, but here is a bag of 50 silver coins.")
print "Player:      'I lost my papers, but here is a bag of 50 silver coins.'"
print "State Label:  " + turn2.label
print "Confidence:   " + turn2.confidence + "%"
print "Guard:       '" + turn2.text + "'"
```

Output:
```text
    Player:      'Merchant convoy arriving to sell dried fruits.'
    State Label:  trade_inquiry
    Confidence:   94.12%
    Guard:       'Show your merchant manifest and keep your hands off the gate.'

    Player:      'I lost my papers, but here is a bag of 50 silver coins.'
    State Label:  bribery_detected
    Confidence:   98.75%
    Guard:       'Bribery is an immediate arrest. Step away from the wagon.'
```


---

## Language Essentials

### Functions & Single-Return Architecture
Functions take comma-separated arguments in parentheses and terminate explicitly with `@` or `return`. DK enforces explicit returns; unvalued exits return `null`.

```dk
~ Implicit quick form
add(a, b) @ a + b

~ Explicit form (recommended for nested functions)
calculateTax(income, rate):
    if income <= 0 @ 0 #
    total = income * rate
@ total


~ First-class inline callback
multiplier = fn(x) @ x * 2
```


### Arrays, Maps, and Rebasing
```dk
~ 1-Based Default Array
items = ["first", "second", "third"]
print items[1]      ~ "first"

~ Scoped zero-based read (underlying array remains 1-based)
print items[1](0)   ~ "second"

~ Hybrid array with keyed and indexed access
entity = [100, 200, ^name: "Sentry"]
print entity[1]     ~ 100
print entity.name   ~ ["Sentry"]
```


### Classes & Sigils
Classes use native sigils (`**`) or the friendly `class` alias. Constructors use `in()`, while `self` or `this` handles instance properties:

```dk
** VectorClock
    in(nodeId)
        self.id = nodeId
        self.ticks = 0
    @

    tick()
        self.ticks += 1
        @ self.ticks
    @
**

clock = VectorClock("node-alpha")
clock.tick()
```


---

## Canonical Forms

DK is permissive and expressive. You can type code in lots of different ways but there is a single canonical form used when sharing code. 

The native `minify()` function ingests code and produces deterministic canonical DK:

* DK allows comments, `return` statements, implicit function boundaries, and class aliases.
* Canonical DK normalizes returns to `@`, enforces `:` on named function boundaries and rewrites class aliases to `**`
* All comments, newlines and non-essential whitespace is removed.

```dk
~ Permissive authoring source
function scale(val, factor)
    res = val * factor
return res

~ Canonical minified output
scale(val,factor):res=val*factor @res
```
