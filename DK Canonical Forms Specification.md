# DK Canonical Forms Specification

Status: Draft working spec for canonical DK output.

Purpose: define the normalized DK text form used by tooling, especially `minify(...)` and DKP transport.

---

## 1. Core Idea

DK authoring stays permissive.

Canonical DK is the strict normalized form produced for transport, comparison, hashing, and agent-to-agent exchange.

This means:

* people may write DK using any legal surface form
* tooling may accept multiple equivalent spellings
* canonical output must choose one preferred spelling for each construct
* DKP-facing code should use canonical DK, not just whitespace-stripped DK

The goal is not "smallest possible text at any cost".

The goal is:

* short
* unambiguous
* stable
* machine-friendly
* deterministic

---

## 2. Canonical DK Versus Authoring DK

Authoring DK:

* may use friendly aliases
* may use implicit forms
* may include comments
* may prefer readability over strict normalization

Canonical DK:

* removes comments
* removes non-essential whitespace
* chooses one preferred form per construct
* avoids parser-guessing forms where an explicit boundary exists
* should serialize equivalent code consistently

In short:

* permissive DK is for writing
* canonical DK is for exchange

---

## 3. Canonical Function Rules

This is the most important normalization area.

DK allows multiple function forms in source, but canonical DK must remove ambiguity.

### 3.1 Named Functions

Canonical minified output uses explicit function boundaries for all named functions:

    add(a,b):@a+b

    in():
    @

This applies even when the source used an implicit form such as:

    add(a,b) @ a+b

Reason:

* minified DK is usually a single line
* implicit function boundaries become harder to inspect in dense or nested code
* canonical DK should prefer explicit structure over parser guesswork

Therefore:

* all named functions use `:`
* this applies to top-level functions
* this applies to nested functions
* this applies to `in()`

### 3.2 Anonymous Function Values

DK includes an anonymous function form for function values used inline or assigned as expressions.

Examples:

    map(items,fn(x)@x+1)

    f=fn(x):@x+1

`fn(...)` and `function(...)` are equivalent authoring forms for anonymous functions.

Canonical DK should treat them as the same construct.

For named function definitions, canonical DK should not use `fn` or `function`.

Instead, named functions should print as normal named function declarations:

    add(a,b):@a+b

This keeps the language model simple:

* named functions use the named-function form
* anonymous function values use the anonymous form
* `fn` is friendly surface syntax, not a separate semantic category from `function`

### 3.3 Return Form

Canonical DK always uses `@`.

Examples:

    add(a,b):@a+b

    test(x):
    if x>10 @ "high" #
    @ "low"

`return` remains legal in authoring DK, but canonical output should normalize it to `@`.

### 3.4 Function Endings

Canonical DK does not use comments, layout tricks, or visual spacing as function boundaries.

Function termination remains explicit through `@`.

Canonical DK must never rely on:

* indentation alone
* comments
* accidental spacing
* implicit nested structure where explicit structure exists

---

## 4. Canonical Block Rules

Canonical DK always uses `#` for block termination where the language requires a block closer.

Examples:

    if ok print "yes" #

    for i 1..3
    print i
    #

This applies to control-flow blocks such as:

* `if`
* `else`
* `switch`
* `try / err`
* `for`
* `while`
* AI-as-Code blocks that terminate with `#`

Canonical DK should not invent alternate visual terminators.

---

## 5. Canonical Keyword And Alias Rules

Canonical DK should prefer the most stable core spelling for each construct.

### 5.1 Return

Canonical form:

    @

Non-canonical but legal authoring form:

    return

### 5.2 Anonymous Function Form

Current rule:

* `fn` and `function` are equivalent anonymous-function spellings
* canonical DK should not use them for named function definitions
* canonical DK may choose one anonymous-function spelling later if needed

The important distinction is structural, not cosmetic:

* named definition: `name(args):...`
* anonymous function value: `fn(args)...` or equivalent normalized form

### 5.3 Classes

Canonical DK uses sigil classes:

    ** Name
        ...
    **

Aliases such as `class` and `CLASS` remain legal in authoring DK, but canonical output should normalize to `**`.

### 5.4 Modules

Canonical DK should use the shortest stable local-module form.

Preferred forms:

    use std/math

    use m=std/math

Longer alias spellings remain legal in authoring DK, but canonical output should prefer the compact alias form when aliasing is needed.

---

## 6. Canonical Comment Rules

Canonical DK strips all comments.

That includes:

* `~ ...`
* `// ...`
* `~~ ... ~~`

Comments are useful for authoring, but they are not part of canonical transport output.

DKP should carry executable canonical DK, not commentary.

---

## 7. Canonical Whitespace Rules

Canonical DK removes all non-essential whitespace.

Canonical DK should be printed with minimal whitespace.

The exact whitespace emitted may vary where the printer needs it for safe output, but whitespace is not itself part of the canonical style contract.

Examples:

    add(a,b):@a+b

    use m=std/math

    if x>0 print x #

Canonical DK is not required to preserve source formatting style.

---

## 8. Canonical DKP Rule

All DK code sent through DKP should be canonicalized first.

That means DKP packets should carry:

* comment-free DK
* normalized spellings
* explicit function boundaries
* stable minimal whitespace

This gives DKP a proper normal form.

Benefits:

* equivalent code can serialize identically
* transport packets become easier to diff
* signatures and hashes become meaningful
* agents do less guessing
* trust and review workflows become clearer

---

## 9. Minifier Contract

`minify(...)` should be understood as a canonicalizer, not just a whitespace remover.

Its job is:

1. parse permissive DK source (read good DK code)
2. normalize equivalent surface forms (strip non-functioning code elements)
3. emit canonical DK text (provide good DK code in the canonical form)

The minifier should therefore:

* remove comments
* normalize `return` to `@`
* normalize class aliases to `**`
* normalize module aliasing to compact canonical forms where possible
* emit explicit `:` for all named functions
* emit minimal safe whitespace
* keep language meaning unchanged

It should operate from structure, not from brittle text substitutions.

In practice this means:

* parse first
* remove and transform code
* print canonical DK from the parsed form

---

## 10. Non-Goals

Canonical DK is not intended to:

* remove legal language flexibility from authors
* define a separate language
* compress beyond readability-at-transport
* rely on undocumented parser quirks

> Canonical DK is a normalized profile of DK, not a replacement for DK itself!