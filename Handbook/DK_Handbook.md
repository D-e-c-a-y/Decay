# DK Handbook

A one-stop technical guide to the DK language.

---

## Table Of Contents

1. Philosophy
2. Quick Start
3. Execution Model
4. Functions And Closures
5. Arrays, Maps and Rebasing
6. Control Flow
7. Errors And Safety
8. Classes And Object Patterns
9. Execution, Host, And Async
10. Modules And `use`
11. AI as Code
12. Built-ins Reference
13. DK Protocol (DKP)
14. Quirks, Gotchas, And Behaviour Notes

---

## 1. Philosophy

DK is a minimalist yet friendly scripting language designed to remove friction between idea and execution.

It strips away unnecessary ceremony: no brace-heavy block syntax, no semicolons, no boilerplate, while preserving power, flexibility, and clarity. You write what you mean, directly.

DK is built around a few core principles:

- Minimal syntax, maximum expressiveness
  Multiple valid forms, fewer rigid rules.

- Friendly-first design
  Defaults are intuitive where possible, while still exposing the real runtime model.

- Runtime-first architecture
  DK compiles to VM bytecode and executes immediately.

- AI as Code
  AI constructs (`neural`, `solver`, `brain`) are intended to feel as natural to use as traditional language features like `if` or `switch`.

- Honest features over fake abstractions
  If something is narrow, partial, or restricted, it should be documented that way.

---

## 2. Quick Start

It's really easy to get started with DK - just start typing! Here are some examples so you can get a feel for the syntax:

### Hello World

    print "Hello, DK"

### Comments

    ~ This is a single-line comment

    ~~ 
    This is a multi-line
    comment block
    ~~

---

### Functions

    add(a, b) @ a + b
    print add(2, 3)

---

### Arrays And Maps

    arr = [1, 2, 3]
    user = [name:"DK", role:"Admin"]

    print arr[1]
    print user.role

---

### Loops

    for i 1..5
        print i
    #

    for i <= 5
        print i
        i += 1
    #

---

> Don't worry if the AI as Code blocks look advanced at first, Section 11 breaks them down step by step.

### Solver (AI as Code)

    result = solver
        [
            x: [1, 2, 3],
            y: [4, 5, 6]
        ]
        rules [
            x + y == 7
        ]
    #

    print result.best

---

### Brain (local AI)

    res = brain
        use weights "model.json"
        prompt "hello world"
    #

    print res.text

---

## 3. Execution Model

DK source is parsed, compiled to VM bytecode, and executed by the runtime.

Top-level code runs from top to bottom.

in() is optional, but if present it is invoked automatically with the current runtime flags available.

DK also supports the entry-point flag signature form:

    in([allowImplicitNested:false])
        print "start"
    @

The runtime flags are also available through `__dk_flags`.

Execution is sequential:

    no scheduler

    no task system

    no parallel runtime

DK is Promise-aware, but not concurrent.

Example:

    sleep(100)
    print "Done"

---

Async Note

If a native or closure returns a Promise, the VM pauses until it resolves, then resumes execution.

Example:

    work()
        sleep(50)
    return "ok"

---

## 4. Functions And Closures

Functions in DK are flexible and expressive, but they follow a few strict rules. Understanding these early will prevent most common mistakes.

In DK, a Function:

    must be introduced by a callable form

    cannot be declared as a bare ()

    takes parameters

    returns a value

    can capture surrounding variables (closures)

    must explicitly terminate with @ or return

### The Core Rule

Every function must contain a terminating @ or 'return' keyword. 

In DK:

    @ and return are equivalent

    both return a value

    both terminate the function body

    if no variable or expression is refined it will return null

> There is no implicit return.

### The DK Function Model

DK really has three core function forms:

- DK Implicit (minimal 'regular' form)
- DK Explicit (for parser clarity)
- Reserved function form (`fn(...)` / `function(...)`)

1. DK Implicit Functions

Example:

    add(a, b) @ a + b

    minimal syntax

    best for simple top-level functions

    can also work in nested code when the structure is simple enough for the parser to understand


2. DK Explicit Functions

Example:

    add(a, b): @ a + b

    same runtime behaviour as the implicit form

    makes the function boundary explicit

    recommended for nested or more complex code


3. Reserved function form

Example:

    map(items, fn(x) @ x + 1)

    introduced by the keyword `fn`

    expression form

    mainly used inline for callbacks, mapping, filtering, and other one-off cases

`fn` and `function` are keywords, not function names.

The reserved form gives you a function value without requiring a user-defined function name in the declaration itself.

If you assign that value, the variable or field you store it in becomes the reusable handle for calling it again.

DK does not support a bare `()` function declaration.

A function is introduced either by:

    a user-defined function name, such as add(a, b)

    a reserved function form introduced by `fn` or `function`, such as fn(x) or function(x)

These are real and implemented, but the three-form model above is the simplest way to think about DK functions.

Other implemented spellings:

    fn add(a, b) @ a + b
    function add(a, b) @ a + b

    f = fn(x) @ x + 1
    f = function(x) @ x + 1

### Parameter Rules

    parameters must be inside ()

    multiple parameters must be comma-separated

    whitespace alone does not separate parameters

Valid:

    add(a, b)


Invalid:

    add a b
    add (a b)

### Decision Guide

Use:

    DK Implicit -> simple top-level functions; perfect for quick scripts

    DK Explicit -> nested or complex functions; recommended default in real code

    Reserved form (`fn` / `function`) -> inline callbacks, one-off function values, and functional-style expressions

> Practical Advice:

    prefer clarity over clever minimalism in nested code

    if something looks ambiguous, make it explicit

    do not treat ~ or # as a function terminator; the function ends at @ or return

### Nested Functions

Safe, explicit nesting:

    outer():
        inner():
            @ 7
        @ inner()
    @

The explicit form makes it clear to the parser what's a function definition and what's a call. Use this form when you have complex nested functions (or all the time, if you like!).

Implicit nesting can also work when the shape is simple:

    outer()
        inner()
            @ 9
        @ inner()
    @

### Special Case: in()

in() is not required, but it is called automatically if it is present.

That makes it useful for:

    startup structure

    entry-point clarity

A DK script can begin directly with top-level code (just start writing and go!), but in() gives you a clear place to begin when you want one.

Important Scoping Rule: Apart from being the entry point, in() is just another function. Any variables defined inside in() are local to that function and do not leak into the global scope.

Example:

    in()
        print "start"
    @

#### Special Case: Class Initializer (in)

Inside classes:

    ** Example
        in(x)
            this.x = x
        @
    **

Rules:

    returning a value is not allowed

    bare return or @ returns self

### Summary

    functions must end with @ or return

    no implicit return exists

    DK has three core function forms: implicit, explicit, and reserved function form

    implicit nested functions can work, but explicit nesting is safer

    in() is optional, auto-called if present, and useful for startup structure and scope isolation

---

## 5. Arrays, Maps and Rebasing

### Arrays

In DK, arrays are written using square brackets.

Example:

    myArray = []
    myArray[1] = "Hello"
    print myArray

    Output: ["Hello"]

---

DK arrays are:

- an ordered collection of values.
- 1-based by default  
- dynamically sized - no need to specify how large an array needs to be
- capable of holding mixed types  

Example:

    arr = ["A", 42, true]

    print arr[1]
    Output: "A"

    print arr[2]
    Output: 42

    print arr[3]
    Output: true

### Keys on Arrays

DK arrays can also accept key-based access.

Example:

    arr = []
    arr[^label] = "Primary" ~ NOTE: the '^' sigil simply denotes a string. It's common to use it for keys

    print arr[1]
    
    Output: "Primary"

    print arr.label
    
    Output: ["Primary"]

This is hybrid-array behaviour, explained in more detail below.

### Maps

In DK, maps store values by key rather than by position.

The Map literal is:

    [:]

Example:

    user = [:]

    user[^name] = "Tom"

    print user

    Output: [^name: "Tom"]

Keys are usually strings, and in DK it is common to write them with `^` instead of quotes.

Example:

    user = [^name: "Tom", ^age: 30]

    print user[^name]

    Output: "Tom"

    print user[^age]
    
    Output: 30

Maps also support dot access:

    print user.name

    Output: "Tom"

Maps are read by key, not by numeric position.

If the same key appears more than once, DK keeps all the values together in an array:

    user = [^name: "Tom", ^age: 30]
    user += [^name: "Tim"]
    user += [^name: "Tam"]

    print user.name

    Output: ["Tom", "Tim", "Tam"]

If you want a pure map, use `[:]` or create the value with key/value pairs only.

### Hybrid Arrays

DK uses Hybrid Arrays, which allow both keys and indexes.

You can create a hybrid explicitly with:

    [/]

A mixed literal also creates a hybrid:

    user = [1, 2, ^name: "DK"]

You can also start with an Array and add a key:

    h = []
    h[^name] = "Tom"
    print h[1]

    Output: "Tom"

    print h.name

    Output: ["Tom"]

In a Hybrid Array, keyed entries are added to the sequence just like other values.

You can see the keys in insertion order with `keys()`:

    h = [1, 2]
    h[^name] = "Tom"
    h[^role] = "Pilot"
    print keys(h)

    Output: [name, role]

If the same key appears more than once, DK keeps each entry in its own place so the index order is preserved.

Reading by key returns all matching values:

    h = [1, 2]
    h[^name] = "Tom"
    h[^role] = "Pilot"
    h[^name] = "Tim"
    print h

    Output: [1, 2, ^name: Tom, ^role: Pilot, ^name: Tim]

    print h.name

    Output: ["Tom", "Tim"]

    print keys(h)

    Output: [name, role, name]

### Map / Array Type Comparison Table

| Feature / Behavior    | Standard Array (`[]`)     | Map (`[:]`)           | Hybrid Array (`[/]` or mixed)                 |
| :---                  | :---                      | :---                  | :---                                          |
| **Indexing**          | 1-based (rebasable)       | Key-based lookup      | 1-based positions + named keys                |
| **Repeated Keys**     | Nope                      | Overwrites value      | Preserves separate entries in insertion order |
| **Missing Lookup**    | Returns `null`            | Returns `null`        | Returns `null`                                |
| **Literal Syntax**    | `[]`                      | `[:]` or `[^key: val]`| `[/]` or `[1, 2, ^key: val]`                  |

The same information is also provided below:

**Standard Array**

    Indexing: 1-based (rebasable)  

    Repeated Keys: Nope

    Missing Lookup: Returns null

    Literal Syntax: []

**Map**

    Indexing: Key-based lookup  

    Repeated Keys: Overwrites value  

    Missing Lookup: Returns null

    Literal Syntax: [:] or [^key: val]

**Hybrid Array**

    Indexing: 1-based positions + named keys  

    Repeated Keys: Preserves separate entries in insertion order  

    Missing Lookup: Returns null

    Literal Syntax: [/] or [1, 2, ^key: val]


### Missing And Null Behaviour

DK returns `null` when you read a missing index or key.

Missing Array Index:

    myArray = [1, 2, 3, 4]
    print myArray[5]
    
    Output: null

Missing Map or Hybrid Key:

    user = [name: "Tom", role: "Pilot"]
    print user.missing

    Output: null

### Rebasing

DK counts the way people usually count. We start at 1 - friendly!

    grid = ["A", "B"]
    print grid[1]

    Output: A

A lot of other languages and computer systems count from 0 instead.

> That is why rebasing exists.

Rebasing lets DK keep its friendly default while still working naturally with systems that expect a different base.

You can rebase to **any** base value, but in practice **1** and **0** are the most common.

#### The Simple Mental Model

Rebasing does **not** change the underlying data.

It changes **how DK interprets positions**.

A good way to think about it is:

> same data, different ruler

#### Full Rebase: `expr[](base)`

This rebases the value itself.

    grid = ["A", "B"]
    assert("Base 1", grid[1], "A")

    grid[](0)

    assert("Rebase 0", grid[0], "A")

For arrays, wrappers, buffers, typed arrays, and vectors, this changes the stored base metadata on the value itself.

#### Scoped Rebase: `expr[index](base)`

This does a **one-off** read or write using a temporary base override.

It does **not** rebase the original value.

    rbArr2 = ["X", "Y", "Z"]

    assert("Rebase Scoped Read Array", rbArr2[1](0), "Y")

    Output: Y

    assert("Rebase Scoped No Mutation", rbArr2[1], "X")

    Output: X

This shows two important things:

- `rbArr2[1](0)` reads using base `0`
- `rbArr2[1]` still uses the array's normal base

#### Scoped Rebase Write

    rbArr2 = ["X", "Y", "Z"]

    rbArr2[2](0) = "Q"

    assert("Rebase Scoped Write Array", rbArr2[2](0), "Q")
    assert("Rebase Scoped No Mutation", rbArr2[1], "X")

Again, the value itself is not permanently rebased. Instead the new base is used to insert a value at the position specified.

#### Strings Can Be Rebased Too

Yes: strings can be rebased.

But strings are special.

When you rebase a string, DK creates a **view** rather than mutating the original string.

    rbStr = "cat"
    assert("Rebase String Default[1]", rbStr[1], "c")

    s0 = rbStr[](0)

    assert("Rebase String View[0]", s0[0], "c")
    assert("Rebase String View[2]", s0[2], "t")

    assert("Rebase Scoped Read String", rbStr[1](0), "a")
    assert("Rebase Scoped Read String No Mutation", rbStr[1], "c")

> DK string tools are base-1 by default; rebase a string to change this

#### Invalid Rebase Behaviour

Invalid rebases usually do **not** throw an error; however, the usage of an invalid rebased value might.

#### Rebasing Edge Cases

- **Hybrid Keys Stay Put:** Changing an array's base changes how you read positions, but it doesn't break named keys `keys(arr)`, they keep their insertion-order binding right where they belong.

- **Strings are Views:** Rebase a string, and DK creates a lightweight view (strview) for safe read-only positioning. Arrays and buffers, on the other hand, let you both read and write using scoped bases `arr[index](base) = val`.

- **Negative Offsets:** Negative indexes (like -1) always measure backward from the end of the collection relative to whatever base is active at that exact moment.

---


## 6. Control Flow

DK keeps control flow simple and readable. Most control-flow blocks end with `#`, so the examples below show that clearly.

### If / Else

Use `if` when you want code to run only when a condition is true.

Example:

    if x > 10
        print("High")
    #

This runs the block only when `x > 10`.

Use `else` when you want a fallback block for everything that did not match the `if`.

Example:

    if x > 10
        print("High")
    else
        print("Low")
    #

This gives you one block for the true case and one for the fallback case.

### Switch

Use `switch` when you want to compare one value against several possible cases.

Example:

    switch val
        case 1
            print("One")
        case 2
            print("Two")
        default
            print("Other")
    #

This is often clearer than a long chain of `if / else if`.

DK `switch` does not fall through. Once one matching case runs, DK does not continue into the next case automatically.

### `for` Syntax

DK supports three main `for` forms, plus a `while` alias.

1. Range loop

Use this when you want to count from one value to another.

    for i 1..5
        print(i)
    #

You can also count backwards with a reverse range:

    for i 5..1
        print(i)
    #

You can add a custom step at the end of the header:

    for i 1..10 i += 2
        print(i)
    #

2. Three-part loop

Use this when you want setup, condition, and update all in one place:

    for i = 1 i < 5 i += 1
        print(i)
    #

Sometimes this gets called a C-style loop.

3. Condition-only loop

Use this when the loop should continue only while a condition stays true:

    for i < 5
        i += 1
    #

`while` is an alias of the condition-only form:

    while i < 5
        i += 1
    #

You can use whichever form you're used to.

### Break / Continue

Use `break` to leave a loop early.

Use `continue` to skip the rest of the current iteration and move to the next one.

Example:

    for i 1..10
        if i == 5 break #
        if i % 2 == 0 continue #
        print(i)
    #

This loop stops completely when `i == 5`, and skips even numbers before that.

### Nested Control Flow

Control-flow blocks can be nested inside one another.

Example:

    for i 1..3
        switch i
            case 2
                continue
            default
                print(i)
        #
    #

Notice that each nested block still needs its own closing `#`.

### Return Flow

Use `return` when you want to leave a function and send a value back.

Example:

    myFunc(x)
        if x > 10
            return "High"
        #
        return "Low"

This returns as soon as one branch is chosen.

### Try / Err

Use `try / err` when something might fail and you want to handle the error safely.

Example:

    try
        run("invalid code")
    err e
        print(e[^msg])
    #

If the code inside `try` fails, DK jumps to `err` and gives you the error object.

If you want to inspect that error object, give it a name such as `e`.
If you do not need it, you can write `err` on its own without naming the error.

### Execution Rules For Control Flow

Control flow still follows DK's normal execution model.

That means execution is:

    Sequential

    Single VM loop

    Async-aware (Promise pause/resume)

Example:

    print("Start")
    sleep(100)
    print("End")

This prints `"End"` only after `sleep(100)` completes.

### Safety Guards

DK includes safety limits to help prevent runaway execution.

Example:

    for true
        ~ triggers safety limit
    #

This matters most for loops that might otherwise never stop.

### Notes

    `switch` does not fall through

    `for` is the primary loop construct

    `while` is an alias of condition-only `for`

    execution is deterministic unless randomness is used

    control-flow blocks end with `#`

---

## 7. Errors And Safety

### The DK Error Model

DK tries to keep data flowing, but it also stops bad code early.

That is why missing data often returns `null`, while missing globals still halt with an error.

In practice, that means:

- missing data often returns `null`
- missing global names still error
- parser, runtime, host, and AI as Code failures surface as structured DK errors

This gives DK a softer feel for everyday data work, while still making real failures visible and catchable.

### Catching Errors

Use `try / err` when something might fail and you want to handle it safely.

Example:

    try
        run("invalid code")
    err e
        print(e[^msg])
    #

If the code inside `try` fails, DK jumps to `err`.

If you want to use or view the error, give it a name such as `e`.

### Common Error Fields

When you catch an error, you receive a structured object rather than a plain string.

The most useful fields are:

- `msg` - a readable description of what went wrong
- `type` - the general error family
- `code` - a more specific machine-friendly identifier
- `line` - the line number, when available

### Where Errors Come From

#### Parser Errors

Parser errors happen when DK cannot understand the code you gave it.

A simple way to see this is with `run()`:

    try
        run("if x")
    err e
        print(e[^msg])
    #

This is useful when you are generating or validating DK code dynamically.

#### Runtime Errors

Runtime errors happen when the code parses correctly but fails while running.

For example, calling something that does not exist still errors:

    unknownFunc()

This is different from a missing member lookup, which often returns `null` instead.

#### Host Errors

Host errors happen when DK tries to use host functionality that is missing, unavailable, or invalid.

Typical cases include:

- a module cannot be found
- host support is unavailable
- a capability name is invalid
- the host throws during the call

`host_has()` is safe and returns `false` when a capability is unavailable.

`host_call()` can raise `HostError` when:

- the host is unavailable
- the name is invalid
- the capability is missing
- the host throws internally

#### AI as Code Errors

AI as Code features use their own error families when something goes wrong.

Current behaviour includes:

- `solver` uses `SolverError`
- `brain` uses `BrainError`
- `neural` does not currently use a dedicated `NeuralError` family in the live runtime

Examples of AI as Code error codes include:

Brain Error Family (BrainError):

- `BRAIN_RESOURCE_MISSING` Triggered when a required resource path is empty or cannot be found.
- `BRAIN_RESOURCE_PARSE_ERROR` Raised when a model or vocabulary resource fails JSON parsing or binary reading.
- `BRAIN_INVALID_VOCAB` Triggered when a vocabulary file lacks a valid tokens array or has no usable tokens.
- `BRAIN_INVALID_TOPOLOGY` Raised when topology legend definitions are not a valid permutation of `[l, h, w]` or contain non-positive values.
- `BRAIN_INVALID_MODEL` Triggered when model class structures, dimensions, or weight matrices are malformed.
- `BRAIN_UNSUPPORTED_TOPOLOGY_PLAN` Raised when a model uses staged multi-row topologies that the local backend cannot honor.
- `BRAIN_UNSUPPORTED_ENTRY_EXIT` Triggered when entry/exit dimensions are asymmetric or fail to match vocab size requirements.
- `BRAIN_GGUF_PARSE_ERROR` Raised when a GGUF file is truncated or contains invalid header structures.
- `BRAIN_GGUF_UNSUPPORTED_VERSION` Triggered when encountering an unsupported GGUF container version.
- `BRAIN_GGUF_UNSUPPORTED_TENSOR_TYPE` Raised when a tensor type or quantization scheme is not supported for execution.
- `BRAIN_TOPOLOGY_MISMATCH` Triggered when provided runtime topology rows conflict with model metadata or executable contracts.
- `BRAIN_LOCAL_UNSUPPORTED_FORMAT` Raised when a weights resource format is unrecognized by the runtime.
- `BRAIN_UNSUPPORTED_SAMPLE_FIELD` Triggered when an unrecognized configuration field is passed via `sample`.
- `BRAIN_INVALID_SAMPLE` Raised when sampling parameters (`top_p`, `top_k`, `penalty`) fall outside valid bounds.
- `BRAIN_INVALID_CALLBACK` Triggered when a streaming callback is missing or supplied while `stream false` is set.

Solver Error Family (SolverError):

- `SOLVER_DOMAIN_ERROR` Triggered when a domain definition variable is not array-like or the domain map is empty.
- `SOLVER_RULE_ERROR` Raised when a hard constraint inside `rules` evaluates to a non-callable structure.
- `SOLVER_PREFER_ERROR` Triggered when a soft preference inside `prefer` is not callable.
- `SOLVER_OPTIMIZE_ERROR` Raised when an optimization expression or objective kind (`min`, `max`, `bool`) is invalid or not callable.

Neural Error Family (NeuralError):

- `NEURAL_SHAPE_ERROR` Triggered when the initial input shape array is missing, malformed, or fails to match pattern row lengths.
- `NEURAL_MATCH_ERROR` Raised when external WITH values cannot be evaluated or lack required dimensions.
- `NEURAL_CASE_ERROR` Triggered when a winning label lacks a corresponding case block and no fallback is defined.  

### Safety Limits And Guard Rails

DK includes guard rails to help failures stay understandable and bounded.

Examples include:

- runaway loop protection in the runtime
- host capability checks before certain operations
- AI as Code limits such as finite domains, validation, and timeout handling

The goal is not to hide failure, but to make it easier to catch, understand, and recover from it.

---

## 8. Classes And Object Patterns

### Class Basics

DK supports object-oriented programming, but it keeps the boilerplate to a minimum.

DK is a sigil-based language, so classes use `**` as their native form.

If you prefer a word-based style, `class` is available as a friendly alias.

In the current runtime, `CLASS` also works as the same alias form.

Example:

    ** Player
        in(name, hp)
            self.name = name
            self.hp = hp
        @

        heal(amount)
            self.hp += amount
            @ self.hp
    **

This creates a class called `Player` with a constructor and a method.

You can write the same thing with the alias form:

    class Player
        in(name, hp)
            self.name = name
            self.hp = hp
        @

        heal(amount)
            self.hp += amount
            @ self.hp
    class

The sigil form is the native DK style. The word form is there as a helpful alias.

### Constructors With `in()`

In DK we start with `in()`, so inside a class `in()` becomes the constructor.

Use it to set up the new instance when the class is called.

Example:

    ** Pet
        in(name)
            self.name = name
        @
    **

When you create `Pet("Miso")`, DK runs `in(name)` and stores the value on the new instance.

A bare `@` ends the constructor and returns the new instance.

### Fields And Methods

Fields hold instance data. Methods are functions attached to the class.

Example:

    ** Counter
        in(start)
            self.value = start
        @

        next()
            self.value += 1
            @ self.value
    **

Here, `value` is a field and `next()` is a method.

### `self`

Use `self.property` to read or write instance data inside a class.

`this` is a true alias for `self`, so `this.name` and `self.name` mean the same thing.

DK also allows a friendly shorthand inside methods: if a bare name does not resolve to a parameter, local value, or captured value, DK treats it as an instance field.

Example:

    ** Counter
        in(start)
            this.tally = start
            note = "ready"
        @

        bump()
            tally += 1
            @ tally
        @

        label()
            @ "Count: " + self.tally + " (" + this.note + ")"
        **

So in practice:

    self.tally, this.tally, and bare tally access inside methods can all refer to the same instance field

DK checks parameters, locals, and captured values first, then falls back to the instance field.

**Gotcha:** this fallback is convenient, but it can hide shadowing mistakes in beginner code.

If a name could be read in more than one way, prefer `self.` or `this.` to make your intent clear.

### Inheritance And Parent Calls

Classes can inherit from other classes using `:`.

If you want to call the parent constructor or a parent method, wrap the call in braces.

Example:

    ** Warrior : Player
        in(name)
            {Player.in(name, 100)}
            self.rage = 50
        @
    **

This means `Warrior` builds on `Player`, reuses the parent constructor, and then adds its own field.

The braces are doing the same kind of job they do in string insertion: they mark something that should be resolved inline.

In a parent call, braces mean:

    {Player.in(name, 100)}

Resolve this parent call here, in place.

That gives DK one consistent idea for braces: insert or resolve something directly at this point.

### Notes And Constraints

DK supports object-oriented patterns, but keeps them intentionally small and direct.

A few helpful points to remember:

- `**` is the native class form
- `class` is a friendly alias
- `CLASS` also works as the same alias in the current runtime
- `in()` is the constructor inside a class
- use `self` to work with instance data
- use `:` for inheritance
- use braces when calling parent constructors or methods

---

## 9. Execution, Host, And Async

DK runs on different hosts, but your DK code works in the same way.

Most of the language stays the same wherever it runs. The main differences come from what the host provides, such as files, capabilities, and external resources.

### Execution Order

Code runs in order, one step at a time.

That means DK is:

- sequential
- single-threaded
- Promise-aware
- deterministic unless you explicitly use randomness or host behaviour that varies

A simple way to think about it is:

DK keeps running until something pauses it, then it resumes and carries on from the same place.

Example:

    print "start"
    sleep(100)
    print "end"

This prints `"start"`, pauses during `sleep(100)`, then prints `"end"`.

### Hosts

DK can run on different hosts.

Most of the time, that does not change how you write DK itself. What changes is what the host makes available around the language.

Hosts mainly affect things like:

- file access
- resource loading
- module resolution
- named host capabilities

So the language stays stable, while the host shapes what is available around it.

DK does not expose raw host objects directly. Instead, the host provides explicit capabilities that DK can call in a controlled way.

### Host Capabilities

Host capabilities are DK's bridge to the outside world.

Use them when you want DK code to ask the host to do something the language itself does not do directly, such as reading a file, joining a path, fetching JSON, or storing browser data.

The two main tools are:

- `host_has(name)` - checks whether a capability exists
- `host_call(name, args)` - calls a capability

Example:

    if host_has(^path_join)
        full = host_call(^path_join, ["alpha", "beta.dk"])
        print full
    #

    if host_has(^fetch_json)
        data = host_call(^fetch_json, ["/api/user/42"])
        print data[^name]
    #

Use `host_has()` when a capability may or may not exist in the current host.

Use `host_call()` when you are ready to use it.

The exact capability set depends on the host.

Some examples below use common custom capabilities to show the pattern, not to imply that every host provides them by default.

#### Value Conversion

When DK talks to the host, values are converted in both directions.

DK to host:

- arrays become JS arrays
- maps become JS objects
- hybrids and other keyed wrappers become plain JS objects when they carry named keys
- primitives stay as they are

Host to DK:

- JS arrays become DK arrays
- JS objects become DK maps
- primitives stay as they are
- `undefined` becomes `null`

This helps host calls feel natural on both sides.

#### Examples

File and path examples:

    home = host_call(^env_get, ["HOME"])
    print home

    p = host_call(^path_join, ["logs", "today.txt"])
    print p

    text = host_call(^fs_read, ["README.md"])
    print text

Web and storage examples:

    text = host_call(^fetch_text, ["/notes.txt"])
    print text

    data = host_call(^fetch_json, ["/api/status"])
    print data[^state]

    host_call(^storage_set, ["theme", "forest"])

Custom host capabilities work the same way:

    info = host_call(^sum_meta, [[2, 3, 5]])

    print info[^total]
    print info[^count]
    print info[^label]

#### Recommended Pattern

A safe pattern is:

    if host_has(^some_capability)
        result = host_call(^some_capability, [arg1, arg2])
    #

This keeps DK flexible across hosts, because the script can check first rather than assuming the capability exists.

#### Host Capabilities Quick-Reference

- `env_get` Retrieves environment configuration values like HOME.
- `path_join` Safely combines directory paths across target environments.
- `fs_read` Reads file contents directly from the filesystem.
- `fetch_text` or `fetch_json` Retrieves remote text or structured JSON payloads over the network.
- `storage_set` Persists key-value data within host storage layers.
- `input` or `alert` Displays interactive user prompt lines and alert messages.
- `sleep` Pauses single-threaded execution for a specified duration.
- `set_base` or `get_base` Modifies and inspects the global collection indexing base.  

#### Error Behaviour

`host_has()` is safe and returns `false` when a capability is unavailable.

`host_call()` raises `HostError` when:

- the host is unavailable
- the name is invalid
- the capability is missing
- the host throws internally

That means capability checks are soft, but capability calls are real runtime operations.

### Async Behaviour

DK supports async behaviour, but keeps it simple.

The mental model is:

- the VM pauses
- a Promise-backed or host-backed operation completes
- the VM resumes

Everything is still sequential.

That simplicity is deliberate. You do not need to manage tasks, scheduling, or parallel flow just to write ordinary DK code.

Example:

    print "start"
    sleep(100)
    print "end"

Execution pauses during `sleep(100)`, then continues.

#### Host-Backed Async

Some operations pause because the host or a native function returns a Promise.

Example:

    text = fetch_text("https://example.com")
    print text

From DK's point of view, execution simply pauses and resumes.

On failure, `fetch_text()` usually returns a text error such as `"Error: ..."` rather than throwing.

#### Closures Across Async

Closures remain stable across async suspension.

Example:

    makeAdder(x)
        @ fn(y) @ x + y
    @

    add5 = makeAdder(5)
    sleep(10)
    print add5(10)

Even though execution pauses, the closure still keeps its captured value.

#### Error Propagation

Errors still propagate normally across async boundaries.

Example:

    try
        run("bad code")
    err e
        print e[^msg]
    #

If something fails after an async pause, DK still routes the error through the normal error system.

#### Important Notes

A few useful things to remember:

- async in DK is driven by host/native Promises
- execution is still single-threaded
- async behaviour depends on the function you call
- the runtime stays simple and predictable while work is paused and resumed

So DK is Promise-aware, but it still keeps one clear flow of execution.

### Runtime Note

`run()` executes DK code from a string.

Use it when you want DK to parse and run new code dynamically.

`run()` uses a child VM rather than the current one.

That means it does not evaluate in the current scope.

The child VM still inherits the current runtime flags and DKP sigils.

This is useful to remember whenever you are reasoning about isolation, globals, or dynamically executed DK code.

---
## 10. Modules And `use`

DK modules let you split code across files and bring them into the current script with `use`.

The `use` system is practical and real, but intentionally narrow. It is designed for local modules, not a package ecosystem.

### Mental Model

When the runtime loads a module, it:

- finds the file
- compiles it in module mode
- executes it immediately
- invokes module-local `in()` automatically if the module defines one
- creates a wrapper containing the globals the module leaves behind

That means `use` does not just point at another file. It runs that file and gives you back a wrapper over what it defined.

If a module defines `in()`, that entry point receives the current runtime flags in the same way as the main script entry point.

### Scope

**Automatic Exports:** Variables, functions, and classes defined at the top level of a module file are automatically captured as exports. When the wrapper object is returned, these variables, function and clasess are available with `use` (see below).

**Private Internals:** Any internal variables, helper definitions, or states specified within local functions, closures, or in the module's local `in()` entry point stay strictly within that execution context and are not avaiable outside of this.

### Creating A Module

A DK module is just a normal `.dk` file.

Nothing special is required.

A module does not need:

- a `module` declaration
- a `version`
- an `in()`
- an `export` keyword

If another script loads the file with `use`, DK treats it as a module, runs it, and builds a wrapper from the globals it leaves behind.

In practice, a useful module usually defines at least one function, value, or class that another file can access.

### Basic `use` Forms

DK currently supports these use forms:

Example:

    use std/math
    use m = std/math
    use std/math as m
    use "./local_module"

These let you either load a module directly or bind it to a shorter local name.

### Exports And The Module Wrapper

DK modules export the globals they leave behind when they finish running.

Top-level functions and classes become globals in that module, so they can also be exported and included in the wrapper returned by `use`.

There is no explicit export syntax.

Instead, the module's exports are whatever globals it leaves behind.

Example module:

    version = "1.0"

    add(a, b)
        @ a + b

    ** Animal
        speak()
            @ "Woof!"
    **

Importing script:

    use zoo

    print zoo.version
    print zoo.add(2, 3)

    pet = zoo.Animal()
    print pet.speak()

Here, `zoo` is the wrapper created by `use`. DK builds it from the globals left behind by the module.

You can also bind that wrapper to a shorter name:

    use z = zoo

    print z.version
    print z.add(2, 3)

### Behaviour

A few important things to remember:

- modules execute immediately when they are used
- exports are inferred from the globals left behind
- there is no explicit export syntax
- the imported value is a wrapper around those exported globals

This keeps the system simple, but it also means module loading is an active runtime step rather than a passive file reference.

### Resolution

The language-level behaviour stays the same across hosts. The main difference is how module paths are resolved.

#### In Node

In Node, module lookup checks:

- the importing file's directory
- the current working directory
- the project root

If the path has no extension, `.dk` is inferred.

#### In The Browser

In the browser, module loading depends on the browser host rather than normal OS path resolution.

So the language stays the same, but the host decides how those module files are provided.

### Missing Modules And Errors

Missing modules fail with DK-visible errors.

Typical behaviour is:

- missing module -> `ModuleError`
- unavailable host module support -> `HostError`

### Callable Module Convenience

There is one narrow convenience rule:

Normally, `use` gives you a wrapper, and you access exported values through that wrapper.

Example:

    use zoo
    pet = zoo.Animal()

There is also a shortcut in the current runtime.

If a module exports a value with the same basename as the module, DK may let you use that exported value directly.

This is why code like this can work:

Example:

    use Animal
    myPet = Animal()

Why this works:

- the module is called `Animal`
- it exports a top-level global also called `Animal`
- DK recognizes that match and lets the imported name resolve directly to that exported value

So this is best understood as a convenience shortcut, not as the main rule of the module system.

The main rule is still that `use` gives you a wrapper built from the globals the module leaves behind.

### Limits And Boundaries

DK modules are intentionally small in scope.

A few current boundaries are worth keeping in mind:

- local imports only
- no package manager
- no explicit export keyword
- module loading is immediate rather than designed around deferred async setup
- module cycles are not a supported pattern in the current loader

These are part of keeping the module system practical and narrow.

---
## 11. AI as Code

DK includes a small set of native blocks that go beyond ordinary control flow.

They are built into the language, so when a problem is about matching, searching, or guided generation, you can reach for a DK feature directly instead of building a separate system around `if`, `switch`, or `for`.

### Mental Model

- Use `neural` when you want to match known patterns against live input
- Use `brain` when you want model-backed interpretation or generation
- Use `solver` when you know the rules, but want DK to search for a valid or best answer

These blocks are related, but they are not interchangeable. They solve different kinds of problems.

### `neural`

`neural` compares external values against a set of pattern rows, chooses the closest match, and then resolves the matching `case`.

This is useful when a normal `switch` would become awkward or too large, but you still want a deterministic result. In true DK style, the shape of the block tells the parser what each line means.

A `neural` block is made of a few different parts:

- an optional name
- one unlabelled array at the top, which defines the input shape
- one or more labelled pattern rows
- a `WITH` line, which supplies the external values to compare
- `case` lines, which define what each winning label should do
- an optional `fallback`
- an optional `limit`

Example:

    player_hp = 20
    enemy_dist = 50
    enemy_rage = 10

    decision = neural threat_check
        [health, distance, rage]
        [20, any, any] Panic
        [80, 10, 90] Enrage
        WITH [player_hp, enemy_dist, enemy_rage]
        limit 75
        case Panic "Retreating"
        case Enrage "Attacking"
        fallback "Idle"
    #

    print(decision.last)
    print(decision.action)

Output:

    Panic
    Retreating

### How DK Reads This Block

    decision = neural threat_check

This starts a `neural` block, gives it the name `threat_check`, and stores the result in `decision`.

The name is optional, but useful when you want the block to be named clearly.

---

    [health, distance, rage]

Because this is a bare array near the top of the block, DK treats it as the input shape.

This defines the order and meaning of the inputs for the whole block.

It is not a pattern row, because it has no label attached to it.

It is not the external data either. Think of it as the template for the classifier.

This input order matters for the rest of the block. Your pattern rows and your `WITH` values should stay in this same order.

---

    [20, any, any] Panic

This is a pattern row.

Because it is an array with a label on the same line, DK treats it as a row to match against.

It says: if the first value is close to `20`, and the other two positions can be anything, label this match as `Panic`.

`any` means that slot is ignored during matching.

The label can come after the row, as shown here, or before it:

    Panic [20, any, any]

Both forms are valid, as long as the row keeps the same input order.

---

    [80, 10, 90] Enrage

This is another pattern row.

It says: if the incoming values are close to `80`, `10`, and `90` in that order, label the match as `Enrage`.

As you build the block, each pattern row should follow the same input order set by the shape line.

---

    WITH [player_hp, enemy_dist, enemy_rage]

Because this line starts with `WITH`, DK treats it as the external values to test.

These are the current variable values that DK compares against the pattern rows above.

Using different names here helps make the distinction clearer:
the first array defines the shape, while `WITH` provides the values being checked right now.

Keep these values in the same order as the shape line and the pattern rows.

---

    limit 75

This sets the minimum confidence score a match must reach.

DK scores each pattern row, picks the highest-scoring one, and then checks it against `limit`.

If the best match scores below `75`, DK treats that as not strong enough and uses the fallback instead.

Use `limit` when you want to reject weak matches rather than always accepting the closest row.

---

    case Panic "Retreating"

If the winning label is `Panic`, the result action becomes `"Retreating"`.

---

    case Enrage "Attacking"

If the winning label is `Enrage`, the result action becomes `"Attacking"`.

After defining your pattern rows, add a `case` for each label you want to handle.

---

    fallback "Idle"

If no row reaches the limit, DK uses this instead.

Add `fallback` when you want a safe default result.

---

    #

The `#` is required to close the block.

Without it, DK will keep reading and treat the following lines as part of the `neural` block.

#### Neural Return Object

A `neural` block returns a small result object.

Its result fields are:

- `last` - the winning label
- `confidence` - how strong the match was
- `action` - the value returned by the matching `case`, or the fallback

So with the example above, you might read:

    decision.last
    decision.confidence
    decision.action

#### Neural Error Behaviour

`neural` does not currently use a dedicated `NeuralError` family in the live runtime.

Instead, neural-related failures show up through DK's normal error system:

- if the block shape is malformed, you will usually see a parser or compiler error
- if an expression inside `WITH`, `case`, or `fallback` fails, you will see the normal DK error for that failure
- a weak match is not an error: if the winning row does not reach `limit`, DK switches to `fallback`

There is one current runtime edge case worth knowing:

- if DK ends on `fallback`, but there is no matching `fallback` action row, `action` becomes `null`
- if a winning label has no matching `case`, `action` also becomes `null`

So the friendly rule is:

    use `fallback` when you want a safe result, not just a safe label

There is also one parser convenience worth knowing:

- if a `case` line gives a label followed by a vector row instead of an action value, DK treats it as another terrain row rather than as an action case

That means a line such as:

    case Panic [20, any, any]

is read as pattern data, not as `"when Panic wins, return this vector"`.

#### Neural Notes

- `neural` accepts both brace and non-brace forms
- an initial contract array can be parsed and stored, but it is not used by the live runtime
- masking supports `"any"`, numeric `NaN`, and a variable named `any`
- the scoring path itself is synchronous
- if a chosen action is async, execution follows the normal VM async path
- there is no dedicated `NeuralError` family at the moment
- if a row has no active scored positions, its confidence becomes `0`

### `brain`

`brain` runs a model using the resources and settings you provide, then returns a result object.

This is the block to use when you want model-backed interpretation, classification, or generation inside DK. As with other DK blocks, the structure of the block tells the parser what each line means.

A `brain` block is made of these parts:

- an optional name
- one or more `use` lines, which load resources
- optional setup lines:
  - `config`
  - `with`
  - `entry`
  - `exit`
  - `limit`
  - `stop`
  - `sample`
  - `identity`
  - `memory`
  - `stream`
  - `callback`
- a `prompt` line, which gives the block its input
- a closing `#`

Example:

    probe = brain
        use weights "models/test_brain_model.json"
        use vocab "models/test_brain_vocab.json"
        limit 12
        prompt "threat packet alert"
    #

    print(probe.label)
    print(probe.text)

Output:

    security
    Security risk detected inspect packet now

Alternative example:

    probe = brain
        use weights "models/test_brain_lm_model.json"
        limit 12
        sample [temp: 0, seed: 1000]
        memory true
        prompt "continue"
    #

    print(probe.text)
    print(probe.memory)

Output:

    security risk detected inspect packet now
    true

### How DK Reads This Block

    probe = brain

This starts a `brain` block and stores the result in `probe`.

The name is optional. In many cases you will simply assign the result directly like this.

---

    use weights "models/test_brain_model.json"

Because this line starts with `use`, DK treats it as a resource line.

Here, `weights` is a functional label, not just a descriptive one. It tells DK that this resource should be treated as model data.

In local runtime paths, this model data can come from a supported JSON model file or a supported GGUF file.

---

    use vocab "models/test_brain_vocab.json"

This is another resource line.

Here, `vocab` tells DK that this resource should be treated as vocabulary data.

In practice, a `brain` block often starts by loading one model resource and, where needed, one vocab resource.

If you leave the label out, DK can often infer the kind from the file name and contents, but explicit labels are clearer and safer.

---

    limit 12

This sets the runtime output limit.

In generation-style paths, `limit 12` means the block should stop after at most 12 output tokens.

In classifier-style paths, the runtime still expects a positive limit and uses it as part of the setup for the run.

So `limit` is not just a vague safety setting. It is part of how `brain` defines the size and bounds of the work it is allowed to do.

Use `limit` when you want the block to stay controlled and predictable.

---

    prompt "threat packet alert"

Because this line starts with `prompt`, DK treats it as the input for the block.

This is the actual text or expression the model works from.

The earlier lines prepare resources and runtime settings. The `prompt` line gives the block its task.

---

    #

The `#` is required to close the block.

Without it, DK will keep reading and treat the following lines as part of the `brain` block.

### All Optional Setup Lines

These are the optional setup lines DK currently supports inside a `brain` block:

    config <base>

Supplies configuration data. This is parsed as part of the block setup.

---

    with <base>

Supplies topology legend information.

---

    entry N

Sets the entry size.

---

    exit N

Sets the exit size.

---

    entry,exit N

Sets both entry and exit to the same value.

---

    limit N

Sets the runtime output limit. This must be a positive number.

---

    stop <base>

Supplies one or more stop patterns. These tell DK where generation should stop.

---

    sample <base>

Supplies sampling settings.

Supported sample fields include:

- `temp`
- `top_p`
- `top_k`
- `penalty`
- `repeat_penalty`
- `repetition_penalty`
- `seed`

---

    identity <expr>

Supplies steering text for the model.

This is useful when you want to guide how the model behaves before the prompt is applied.

---

    memory true

Turns transcript memory on.

When memory is enabled, DK carries recent prompt and output text forward into later calls.

---

    memory false

Leaves transcript memory off.

---

    stream true

Turns streaming on.

When streaming is enabled, DK can emit output in chunks as it is produced.

---

    stream false

Leaves streaming off.

---

    callback <expr>

Supplies a callback to receive streamed chunks.

This is only useful when streaming is enabled.

### Model Formats

In local runtime paths, `brain` can load model data from:

- supported JSON model files
- supported GGUF files

This support is narrower than `any JSON` or `any GGUF`. The resource still has to match what DK's local runtime understands.

So the safest wording is:

- `brain` supports local model execution
- JSON and GGUF are supported in narrow, runtime-specific ways
- not every model that looks valid will necessarily be executable

#### Brain Return Object

A `brain` block returns a result object with these fields:

- `text` - the returned text
- `confidence` - the confidence score for the result
- `tokens` - the number of output tokens used
- `mode` - the runtime mode, currently returned as `local`
- `status` - the run status, currently returned as `ok` on success
- `reason` - why this result was produced
- `label` - the classification label, or `generated` for generation-style output
- `memory` - whether memory was enabled
- `stream` - whether streaming was enabled
- `chunks` - streamed chunks collected during the run

So with the examples above, you might read:

    probe.label
    probe.text
    probe.tokens
    probe.reason
    probe.memory
    probe.chunks

The result object also exposes helper methods:

- `probe.tokenize(text)`
- `probe.vectorize(text)`
- `probe.decode(ids)`

### Practical Reading

A good way to read a `brain` block is:

- `use` loads what the model needs
- setup lines control how it should run
- `prompt` gives it work to do
- the return object gives you the result and runtime metadata

#### Brain Notes

- `brain` accepts both brace and non-brace forms
- `entry,exit N` sets both values at once
- `memory` and `stream` only become true when the value is exactly `true`
- `config` is parsed, but the local runtime rejects it
- cloud/provider-style `use` URLs are parsed, but live cloud execution is currently unavailable
- local `brain` has two main runtime paths: classifier and autoregressive generation
- classifier paths reject `sample` maps
- helper methods such as `.tokenize(...)`, `.vectorize(...)`, and `.decode(...)` live on the result object, not as globals
- local loading expects at least one model resource, and only supports one model plus one vocab where needed
- JSON and GGUF support are both narrow and runtime-specific
- some resources can validate successfully but still fail later as non-executable
- `brain` has a dedicated `BrainError` family, including codes such as `BRAIN_RESOURCE_MISSING`, `BRAIN_INVALID_MODEL`, `BRAIN_CLOUD_UNAVAILABLE`, `BRAIN_INVALID_LIMIT`, `BRAIN_TOPOLOGY_MISMATCH`, and `BRAIN_GGUF_EXECUTION_UNAVAILABLE`, along with narrower runtime-specific codes such as `BRAIN_INVALID_CALLBACK`, `BRAIN_UNSUPPORTED_CONFIG`, `BRAIN_INVALID_SAMPLE`, and `BRAIN_LOCAL_UNSUPPORTED_FORMAT`
- `brain` is fully async-capable for resource loading, callbacks, and generation
- local resource loading depends on the host path, such as `readResource(...)` support or browser fetch fallback

### `solver`

`solver` searches through a set of possible values, applies the rules you give it, and returns the best valid result it can find.

This is the block to use when you know the rules of the problem, but do not want to work through every possible combination by hand. As with the other DK blocks, the structure of the block tells the parser what each line means.

A `solver` block is made of these parts:

- an optional name
- one domain map, which defines the variables and their possible values
- optional setup lines:
  - `rules`
  - `prefer`
  - `optimize`
  - `mode`
  - `limit`
  - `timeout`
- a closing `#`

Use this kind of block when you want DK to find the best valid answer from a small search space.

Example:

    solveBest = solver
        [
            x: [1, 2, 3],
            y: [1, 2, 3]
        ]
        rules [
            x != y
        ]
        optimize [
            [max: x + y],
            [min: abs(x - y)]
        ]
    #

    print(solveBest.best.x)
    print(solveBest.best.y)

Output:

    2
    3

Use this kind of block when you want every valid answer, rather than just the first or best one.

Alternative example:

    solveAll = solver
        [
            a: [1, 2],
            b: [1, 2]
        ]
        rules [
            a != b
        ]
        mode "all"
        limit 50
        timeout 2000
    #

    print(solveAll.count)
    print(solveAll.solutions[1].a)

Output:

    2
    1

### How DK Reads This Block

    solveBest = solver

This is the start of the block.

It creates a `solver` block and stores the result in `solveBest`.

The name is optional, but useful when you want to keep or reuse the result clearly.

---

    [
        x: [1, 2, 3],
        y: [1, 2, 3]
    ]

This is the domain definition.

It is an unlabelled map of the variables DK is solving for, and the values each one is allowed to take.

Here, `x` can be `1`, `2`, or `3`, and `y` can be `1`, `2`, or `3`.

This is the first thing to decide when building a `solver` block: what can vary.

---

    rules [
        x != y
    ]

This is the hard rule list.

These rules must be true for a solution to count as valid.

In this example, any combination where `x == y` is rejected.

Use `rules` for conditions that must always hold.

---

    optimize [
        [max: x + y],
        [min: abs(x - y)]
    ]

This is the optimization list.

It does not decide whether a solution is valid. The `rules` have already done that.

Instead, `optimize` helps DK rank valid solutions.

In this example, DK first tries to maximize `x + y`, then tries to minimize the distance between the two values.

Use `optimize` when you want the best valid answer rather than just any valid answer.

---

    #

The `#` is required to close the block.

Without it, DK will keep reading and treat the following lines as part of the `solver` block.

### All Optional Setup Lines

These are the optional setup lines DK currently supports inside a `solver` block:

    rules [ ... ]

This is the hard constraint list.

These rules must pass for a solution to count.

---

    prefer [ ... ]

This is the soft preference list.

These do not make a solution invalid if they fail, but they help rank valid solutions.

Use `prefer` when you want DK to favor some valid answers over others without rejecting the rest.

---

    optimize [ ... ]

This is the optimization list.

These are used to choose the best valid result.

Supported forms include:

- `[max: expr]`
- `[min: expr]`

---

    mode "first"

This tells DK to stop when it has enough information to return the first suitable result.

This is the default unless the search needs to keep going for ranking.

---

    mode "all"

This tells DK to keep all valid solutions it finds and return them in `solutions`.

Use this when you want the full result set instead of just one result.

---

    limit N

This is the search-work limit.

It caps how much search work DK is allowed to do.

---

    timeout N

This is the time limit.

It caps how long DK is allowed to keep searching.

#### Solver Return Object

A `solver` block returns a result object with these fields:

- `ok` - whether DK found at least one valid solution
- `best` - the best valid solution found
- `score` - score information for the best solution
- `count` - the number of valid solutions found
- `complete` - whether the search finished completely
- `mode` - the search mode used
- `solutions` - all returned solutions, when `mode "all"` is used
- `tested` - how many candidates DK tested
- `pruned` - how many candidates DK rejected early
- `reason` - why the search stopped or succeeded

`limit` and `timeout` matter here as well.

If the search stops because it hits a limit or runs out of time, the result object shows that:

- `complete` will be `false`
- `reason` will usually be `limit` or `timeout`

Typical `reason` values are:

- `solved`
- `unsat`
- `limit`
- `timeout`

So with the examples above, you might read:

    solveBest.best
    solveBest.score
    solveBest.reason
    solveAll.solutions
    solveAll.count
    solveAll.complete

### Practical Reading

A good way to read a `solver` block is:

- the domain block says what can vary
- `rules` say what must be true
- `prefer` says what DK should favor
- `optimize` says what DK should try to maximize or minimize
- `mode`, `limit`, and `timeout` control how far the search should go
- the return object tells you what DK found and how the search ended

#### Solver Notes

- `solver` accepts both brace and non-brace forms
- the domain values must resolve to finite array-like collections
- `rules`, `prefer`, and `optimize` only keep `.elements` when they parse as an `ArrayLiteral`
- `optimize` is narrower than it may first appear, and `min` / `max` only work in the accepted map-entry shape
- `limit` caps combinations tested, not the number of solutions returned
- `timeout` uses wall-clock time
- `solver` is deterministic
- rule, preference, and optimization closures can be awaited, but the search still stays sequential rather than parallel
- `solver` has a dedicated `SolverError` family, including codes such as `SOLVER_DOMAIN_ERROR`, `SOLVER_RULE_ERROR`, `SOLVER_PREFER_ERROR`, and `SOLVER_OPTIMIZE_ERROR`

### Choosing The Right Block

If you already know the patterns, use neural.

If you want a model to respond, use brain.

If you want DK to search possible combinations for you, use solver.

---

## 12. Built-ins Reference

This section lists the real, live built-in surface of DK by category for quick reference.

### Core

print(<value to print>) - Prints a value.

clock() - Returns the current time in milliseconds.

str(<value to convert>) - Converts a value to a string.

num(<value to convert>) - Converts a value to a number.

type(<value to inspect>) - Returns the type of a value.

len(<value to measure>) - Returns the length of a string, array, map, hybrid array, or buffer.

clone(<value to clone>) - Returns a deep copy of a value where possible.

Gotcha:

    `type(null)` returns `"object"`

### Strings And Text

upper(<text to convert>) - Converts text to uppercase.

lower(<text to convert>) - Converts text to lowercase.

trim(<text to trim>) - Removes whitespace from both ends of text.

split(<value to split>, <pattern or separator>, <optional limit>) - Splits text, and also supports structured splitting on other collection types.

join(<array of items>, <delimiter>) - Joins array items into a string using a delimiter.

replace(<text>, <find value or pattern>, <replacement>) - Replaces the first match of the find value with the replacement.

sub(<text>, <pattern>, <replacement>) - Replaces all matches of a pattern with a replacement.

startsWith(<text>, <search value>) - Returns true if text starts with a value.

endsWith(<text>, <search value>) - Returns true if text ends with a value.

repeat(<text>, <repeat count>) - Repeats text a number of times.

padStart(<text>, <target length>, <padding text>) - Pads text on the left.

padEnd(<text>, <target length>, <padding text>) - Pads text on the right.

match(<text>, <pattern>) - Returns regex match information.

match_at(<text>, <pattern>, <offset to test from>) - Matches a pattern at a specific offset.

char(<character code>) - Converts a character code to a character.

ord(<text>, <index to read>) - Returns the character code at a given position.

has(<collection or text>, <index key or pattern>) - Checks containment or existence. On strings it tests a pattern, on collections it checks an index or key.

String insertion uses braces to place values directly into a string.

Example:

    name = "Janet"
    score = 42

    print "Hello {name}"
    print "Score: {score}"

A simple way to think about it is:

    braces mean insert this value here

That same idea appears elsewhere in DK too. For example, parent constructor calls also use braces to show that something should be resolved inline at that point.

Gotchas:

    has() uses regex, not substring

    indexOf() is base-aware for strings, arrays, wrappers, and hybrid arrays

### Collections

a[<index>] - Indexed read. Works with Arrays, Maps and Hybrid Arrays.

a[<index>] = <value> - Indexed write. Works with Arrays, Maps and Hybrid Arrays.

a.<key name> - Keyed read using dot access. Works with Maps and Hybrid Arrays. On Hybrid Arrays, this returns an array of all matching values.

a[^<key>] - Keyed read using key syntax. Works with Maps and Hybrid Arrays.

a[^<key>] = <value> - Keyed write. Works with Maps and Hybrid Arrays. On Hybrid Arrays, this appends a new keyed entry at the end.

print(<collection>) - Prints the collection. Works with Arrays, Maps and Hybrid Arrays. Maps and Hybrid Arrays show keys when printed.

str(<collection>) - Returns the string form of the collection. Works with Arrays, Maps and Hybrid Arrays.

type(<collection>) - Returns the type. Works with Arrays, Maps and Hybrid Arrays. Collections currently report as "arr".

len(<collection>) - Returns the indexed length. Works with Arrays, Maps and Hybrid Arrays. On Hybrid Arrays, keyed entries count toward the total length.

has(<collection>, <index>) - Checks whether an indexed position exists. Works with Arrays, Maps and Hybrid Arrays.

has(<collection>, <key name>) - Checks whether a key exists. Works with Maps and Hybrid Arrays.

push(<collection>, <value to append>) - Appends a value to the indexed end. Works with Arrays, Maps and Hybrid Arrays.

pop(<collection>) - Removes and returns the last indexed value. Works with Arrays, Maps and Hybrid Arrays.

shift(<collection>) - Removes and returns the first indexed value. Works with Arrays, Maps and Hybrid Arrays.

unshift(<collection>, <value to insert>) - Inserts a value at the start of the indexed sequence. Works with Arrays, Maps and Hybrid Arrays.

contains(<collection>, <value to search for>) - Checks whether an indexed value exists. Works with Arrays, Maps and Hybrid Arrays.

indexOf(<collection>, <value to search for>) - Finds the index of an indexed value. Works with Arrays, Maps and Hybrid Arrays.

splice(<collection>, <start index>, <delete count>, <optional items to insert...>) - Inserts or removes indexed values. Works with Arrays, Maps and Hybrid Arrays.

fill(<collection>, <fill value>, <start index>, <end index>) - Fills part of the indexed sequence with a value. Works with Arrays, Maps and Hybrid Arrays.

slice(<collection>, <start selector>, <end index>, <step>) - Returns a slice of the indexed sequence. Works with Arrays, Maps and Hybrid Arrays.

forEach(<collection>, <callback function>) - Iterates over indexed values. Works with Arrays, Maps and Hybrid Arrays.

map(<collection>, <callback function>) - Transforms indexed values into a new array. Works with Arrays, Maps and Hybrid Arrays.

filter(<collection>, <callback function>) - Filters indexed values into a new array. Works with Arrays, Maps and Hybrid Arrays.

some(<collection>, <callback function>) - Returns true if any indexed value matches. Works with Arrays, Maps and Hybrid Arrays.

every(<collection>, <callback function>) - Returns true if all indexed values match. Works with Arrays, Maps and Hybrid Arrays.

reduce(<collection>, <callback function>, <initial value>) - Reduces indexed values to one result. Works with Arrays, Maps and Hybrid Arrays.

unique(<collection>) - Removes duplicate indexed values. Works with Arrays, Maps and Hybrid Arrays.

shuffle(<collection>) - Randomly reorders indexed values. Works with Arrays, Maps and Hybrid Arrays.

reverse(<collection>) - Reverses indexed values in place. Works with Arrays, Maps and Hybrid Arrays.

sort(<collection>) - Sorts indexed values in place. Works with Arrays, Maps and Hybrid Arrays.

keys(<collection>) - Returns the keys. Works with Maps and Hybrid Arrays. On Hybrid Arrays, keys are returned in insertion and index order, including duplicates.

values(<collection>) - Returns the keyed values. Works with Maps and Hybrid Arrays. On Hybrid Arrays, values are returned in insertion and index order.

remove(<collection>, <key string to remove>) - Removes a keyed entry. Works with Maps and Hybrid Arrays. On Hybrid Arrays, it removes the first matching key and shifts later indexes up.

merge(<target collection>, <source collection>) - Merges one collection into another. Works with Arrays, Maps and Hybrid Arrays.

<collection> += <value or collection to add> - Appends or merges depending on the collection type. Works with Arrays, Maps and Hybrid Arrays. Arrays append, Maps merge keys, and Hybrid Arrays preserve indexed and keyed ordering.

### Functional Tools

forEach(<collection>, <callback function>) - Calls a function for each indexed value.

map(<collection>, <callback function>) - Builds a new array from transformed indexed values.

filter(<collection>, <callback function>) - Builds a new array from indexed values that pass a test.

some(<collection>, <callback function>) - Returns true if any indexed value passes a test.

every(<collection>, <callback function>) - Returns true if all indexed values pass a test.

reduce(<collection>, <callback function>, <initial value>) - Reduces indexed values to one result.

### General Utilities

clone(<value to clone>) - Returns a deep copy of a value where possible.

### JSON And Encoding

json_parse(<JSON text>) - Parses JSON text into DK values.

json_str(<value to encode>) - Converts a DK value to formatted JSON text.

b64_enc(<text to encode>) - Encodes text as Base64.

b64_dec(<Base64 text to decode>) - Decodes Base64 text.

Gotcha:

    json_parse() returns null on parse failure instead of throwing

### Sensory Restructuring

DK includes robust native tools for data chunking and pattern discovery:

slice(<value to slice>, <start selector>, <end index>, <step>) - Returns a slice or selection from a string, array, map-backed array, hybrid array, or buffer. Supports offset stepping like `slice(1, 6, 2)` and negative indexing like `slice(-3, null)`.

chunk(<value to chunk>, <mode argument a>, <mode argument b>, <mode argument c>, <mode argument d>) - Performs advanced chunking, extraction, and restructuring on strings, arrays, and buffers.

Examples:

    Fixed-size block chunks: `clean_mac.chunk(2)()`

    Sliding window (crawler) chunks: `dna.chunk(3, 1)()`

    Discovery/pattern chunks: `log.chunk(["ID:", 3])()`

Note: The extra set of parentheses are for the base. This is not needed if you are using the default DK base-1.

### Math

max(<value a>, <value b>, <optional more values...>) - Returns the largest number.

min(<value a>, <value b>, <optional more values...>) - Returns the smallest number.

abs(<number>) - Returns the absolute value.

floor(<number>) - Rounds down.

ceil(<number>) - Rounds up.

round(<number>) - Rounds to the nearest integer.

sqrt(<number>) - Returns the square root.

pow(<base number>, <exponent>) - Raises a number to a power.

clamp(<value>, <minimum>, <maximum>) - Restricts a value to a range.

lerp(<start value>, <end value>, <blend amount>) - Linearly interpolates between two values.

sign(<number>) - Returns -1, 0, or 1 depending on the sign.

sin(<angle in radians>) - Returns the sine.

cos(<angle in radians>) - Returns the cosine.

tan(<angle in radians>) - Returns the tangent.

asin(<number>) - Returns the inverse sine.

acos(<number>) - Returns the inverse cosine.

atan2(<y value>, <x value>) - Returns the angle from x and y.

exp(<number>) - Returns e raised to the given number.

log(<number>) - Returns the natural logarithm.

log10(<number>) - Returns the base-10 logarithm.

log2(<number>) - Returns the base-2 logarithm.

trunc(<number>) - Removes the fractional part.

rand() - Returns a random float in `[0,1)`.

rand_int(<minimum integer>, <maximum integer>) - Returns an inclusive random integer.

Behaviour:

all use JS-style numeric coercion

invalid numeric input often produces `NaN` or another numeric fallback instead of throwing

### Buffers, Vectors, And Matrix Tools

buffer(<buffer size>, <buffer type>) - Creates a typed buffer.

dot_product(<vector a>, <vector b>) - Returns the dot product of two vectors.

vec_add(<vector a>, <vector b>) - Adds two vectors.

vec_sub(<vector a>, <vector b>) - Subtracts one vector from another.

vec_scale(<vector>, <scalar multiplier>) - Scales a vector by a number.

vec_mag(<vector>) - Returns the magnitude of a vector.

vec_norm(<vector>) - Returns the normalized version of a vector.

vec_dist(<vector a>, <vector b>) - Returns the distance between two vectors.

mat_mul(<vector>, <matrix>) - Multiplies a vector by a matrix.

vec_softmax(<vector>) - Applies softmax to a vector.

Behaviour:

invalid input usually returns null or 0

operations work on typed arrays

### Time And Environment

date(<optional timestamp>) - Returns a human-readable date string for a timestamp, or for now if omitted.

now() - Returns a high-resolution timer value.

time() - Returns the current Unix timestamp in seconds.

clock() - Returns the current time in milliseconds.

### Host Tools

host_has(<capability name>) - Checks whether the host provides a named capability.

host_call(<capability name>, <arguments collection>) - Calls a named host capability with arguments.

input(<prompt message>) - Shows an input prompt and returns the user's response.

alert(<message to show>) - Shows an alert message.

sleep(<milliseconds to wait>) - Waits for a number of milliseconds.

fetch_text(<URL to fetch>) - Fetches text from a URL.

set_base(<new global base>) - Sets the global indexing base.

get_base() - Returns the current global indexing base.

### Code Execution And Tooling

run(<DK source code>) - Runs DK source code.

minify(<DK source code>) - Minifies DK source code.

mini(<DK source code>) - Minifies DK source code using the mini/minifier path.

run_meta() - Returns metadata about the last run, such as parse warnings.

Gotchas:

    run() does not share scope

### DKP

DKP_sigils() - Returns the currently defined DKP sigils.

DKP_define_sigil(<sigil to add>) - Adds a DKP sigil.

DKP_remove_sigil(<sigil to remove>) - Removes a DKP sigil.

DKP_reset_sigils() - Resets DKP sigils to defaults.

DKP_set_sigils(<list of sigils>) - Replaces the DKP sigil set.

DKP_pack(<sigil>, <DK source>) - Packs DK source into a DKP packet.

DKP_unpack(<DKP packet>) - Unpacks a DKP packet.

DKP_send(<channel name>, <DKP packet>) - Sends a DKP packet to a channel.

DKP_listen(<channel name>, <handler function>) - Listens on a DKP channel with a handler.

DKP_unlisten(<listener id>) - Stops a DKP listener.

Behaviour:

all are host-backed

throw DKPError on failure

### Constants

PI

E

INFINITY

NaN

### Built-Ins Notes

These notes cover common behaviour patterns across the built-ins listed above. They are quick reference notes, not exhaustive guarantees for every built-in.

#### Null vs Throw

DK often prefers a safe return over an exception, but this depends on the specific built-in.

Common safe-return examples:

    missing access returns `null`

    json_parse() returns `null` on parse failure

    host_has() returns `false` when a capability is unavailable

Common throwing examples:

    host_call() raises `HostError` for invalid or unavailable capability calls

    DKP functions raise `DKPError` on failure

    run(), minify(), and mini() raise errors when the toolchain or host path fails

#### Base Awareness

DK can change its indexing base with `set_base()` and `get_base()`.

Base-aware tools adjust positions to match the current base. That includes ordinary collection indexing, `ord()`, `indexOf()`, and `slice()`.

`len()` is not base-aware in this sense because it returns a size, not a position.

Many text transforms such as `upper()`, `lower()`, `trim()`, and `replace()` do not use indexed positions, so the base does not affect them.

`chunk()` also reads the current base for index-sensitive modes, but it has several behaviours, so it is clearer to learn it from its examples than to treat it as a simple always-base-aware tool.

#### Async Behaviour

These actually await:

    sleep

    fetch_text

    run / minify / mini

    DKP functions

    higher-order functions such as map/filter/reduce

Everything else is effectively synchronous.

#### Duplicate Registrations

Some functions are defined multiple times internally.

Rule:

    last definition wins

#### Shadowing

User globals can shadow built-ins.

The compiler also protects some builtin calls internally, so shadowing is not always a complete override.

---
## 13. DK Protocol (DKP)

DKP stands for Decay Protocol.

DKP is DK's protocol for packaging and passing intent as structured pulses. It gives DK code a consistent way to build, send, receive, and inspect protocol messages through host-backed channels.

DKP shapes the message, the host carries it, and your local runtime decides whether to trust or execute it.

### Mental Model

DKP works with three main ideas:

    a sigil identifies the kind of pulse

    a packet is the DKP message itself

    a channel is the route the host uses to send or receive that packet

In practice, this means:

    DKP_pack(...) builds a packet

    DKP_unpack(...) reads a packet

    DKP_send(...) sends it through a host-backed channel

    DKP_listen(...) waits for packets on a channel

    DKP_unlisten(...) stops that listener later

### Default Sigils

DKP starts with these default sigils:

    !! - thought / execute-style pulse
    ?? - reflex / query / immediate response-style pulse
    :: - skeleton / structure-style pulse
    ++ - muscle / payload-heavy or binary-style pulse
    ~~ - signal / handshake / presence-style pulse

You can inspect the current sigil set at runtime with:

    DKP_sigils()

DKP also includes helpers to add, remove, reset, or replace sigils at runtime. The built-ins reference lists them in full.

### Core Operations

Packing and unpacking:

    DKP_pack(<sigil>, <DK source>) - Packs DK source into a DKP packet.

    DKP_unpack(<DKP packet>) - Unpacks a DKP packet.

Sending and listening:

    DKP_send(<channel name>, <DKP packet>) - Sends a DKP packet to a channel.

    DKP_listen(<channel name>, <handler function>) - Listens on a DKP channel with a handler.

    DKP_unlisten(<listener id>) - Stops a DKP listener.

A simple rule of thumb is:

    pack before sending

    unpack when you want to inspect what came in

### Sending A Pulse

This is the clearest send pattern:

    packet = DKP_pack(^!!, "done = 7")
    sent = DKP_send(^local, packet)
    print sent

In everyday use, you normally:

    choose a sigil

    pack the source into a pulse

    send that pulse to a channel

### Receiving A Pulse

This is the clearest receive pattern:

    listener = DKP_listen(^local, fn(pulse)
        print pulse
        @
    )

The handler receives a pulse object.

That object includes:

    pulse.packet - the original packet text

    pulse.sigil - the pulse sigil

    pulse.source - the packet body after the sigil

If you want to inspect the contents more directly:

    listener = DKP_listen(^local, fn(pulse)
        print pulse.sigil
        print pulse.source
        @
    )

When you are finished listening:

    DKP_unlisten(listener)

### Behaviour

DKP functions are host-backed.

That means DK gives you a standard DKP interface, but the host controls the actual channel implementation and availability.

DKP does not create the channel for you. It works over channels that already exist.

DKP also does not make trust or execution decisions for you. Those remain local.

### Errors

DKP functions throw `DKPError` on failure.

If a pulse uses a sigil DKP does not recognize, DK throws an error rather than trying to guess what the pulse means.

This applies when packing, unpacking, sending, or receiving DKP pulses.

### Friendly Rule Of Thumb

If you want to package intent, pass it through a host-backed channel, and keep trust and execution decisions local, DKP is usually the right tool.

---
## 14. Quirks, Gotchas, And Behaviour Notes

DK is designed to keep everyday code moving. That means some parts of the language are deliberately more forgiving, more flexible, or more shape-driven than you might expect if you are coming from stricter languages.

### Nested Implicit Functions Can Become Ambiguous

DK can accept some implicit nested functions, but it will not guess once the shape becomes unclear.

This fails:

    wrapper()
        inner()
        inner()
        @
    @

After the first `inner()`, the parser cannot tell whether you are starting a nested function or making a normal call.

If you want the predictable version, make the nesting explicit:

    wrapper():
        inner():    ~ nested function definition
            inner() ~ normal call inside inner()
        @
    @

If you want to ban implicit nested parsing altogether, DK supports a strict parser flag:

    in([allowImplicitNested:false])
        print "start"
    @

---

### Arrays Carry Extra DK Metadata

DK arrays are still arrays. They are ordered, index-based, and mutable.

What makes them a little unusual is that DK can attach extra runtime metadata to them. That metadata supports features like rebasing, but it does not turn the array into a different kind of structure on its own.

Example:

    arr = [10, 20]
    arr[](0)

    print arr[0]
    print arr[1]

A simple way to think about it is:

    metadata adds behaviour, but the value is still an array

---

### Arrays Can Automatically Become Hybrid Arrays

A plain array stays a plain array until you add named keys.

When you do that, DK keeps the indexed array data and adds keyed behaviour on top. That turns the array into a hybrid array.

Example:

    arr = [10, 20]
    arr[^name] = "DK"

    print arr[1]
    print arr.name
    print keys(arr)

So the important distinction is:

    rebasing uses array metadata

    adding named keys creates a hybrid

That is worth watching for, because once named keys are added, you are no longer working with a plain array.

---

### Pure Keyed Literals Make Maps, Mixed Literals Make Hybrids

DK uses the shape of the literal to decide what structure to create.

A pure keyed literal makes a map:

Example:

    user = [^name: "DK", ^role: "Admin"]

A mixed literal makes a hybrid:

Example:

    user = [1, 2, ^name: "DK"]

So the quick rule is:

    only keys = map

    values and keys together = hybrid

If you want the clearest empty forms, use:

Example:

    m = [:]
    a = []

This matters because maps and hybrids can both hold keyed data, but they do not behave the same way.

---

### Hybrid Arrays Keep Repeated Keys as Separate Entries

Hybrid arrays preserve repeated keyed entries instead of overwriting them.

Each repeated key stays in its own indexed slot. That means DK keeps the insertion order and index position of every value.

Example:

    h = [1, 2]
    h[^name] += "Tom"
    h[^role] += "Pilot"
    h[^name] += "Tim"

    print h
    print h.name
    print keys(h)

That gives hybrids a very particular behaviour:

    repeated keys are kept

    keyed reads can return multiple values

    keys(h) returns keys in insertion order, including duplicates

This is one of the main reasons hybrids are useful. They let DK preserve both indexed structure and keyed meaning at the same time.

---

### Maps And Hybrids Handle Repeated Keys Differently

Maps and hybrids can both store keyed data, but they are not the same kind of structure.

A map is a keyed structure.

A hybrid is an indexed structure with keyed entries attached.

That is why repeated keys behave differently.

If you directly assign the same key again on a map, the new value replaces the old one.

Example:

    user = [^name: "Tom"]
    user[^name] = "Tim"

    print user.name

That is normal map overwrite behaviour.

A hybrid behaves differently. Repeated keyed entries stay as separate indexed values so their positions are preserved.

So the practical rule is:

    maps overwrite direct repeated assignments

    hybrids preserve repeated keyed entries

---

### Merging Can Create Arrays Inside Maps

Section 5 shows the main version of this rule. The short gotcha is that merging is not the same as direct assignment.

With ordinary direct assignment, a map key is replaced.

With merging, if DK hits the same key more than once, it can preserve both values by creating an array at that key.

Example:

    user = [^name: "Tom"]
    user += [^name: "Tim"]

    print user.name

That means repeated map merges can create a nested array value, which can catch people out if they were expecting a single value to stay in place.

A simple way to remember it is:

    assignment usually replaces

    merging can preserve both values

---

### Missing Data Usually Returns null

DK is intentionally soft when data is missing.

Example:

    print [1, 2][99]
    print [:].missing
    print "abc"[10]
    print data[99].bad

This reduces friction in everyday code. You do not need to guard every lookup just to avoid a crash.

---

### Missing Globals Still Error

This still fails:

Example:

    unknownFunc()

A good way to remember the rule is:

**missing data is usually soft; missing globals are still hard errors**

DK tries to keep data flowing, but it still protects you from typos and missing global names.

---

### Rebasing Exists to Be Flexible

Rebasing lets you change how indexing is interpreted without changing the underlying data.

Full rebase:

Example:

    grid = ["A", "B"]
    grid[](0)
    print grid[0]

Scoped one-off rebase:

Example:

    rbArr = ["X", "Y", "Z"]
    print rbArr[1](0)
    print rbArr[1]

Strings can also be rebased, but DK creates a view instead of mutating the original string:

Example:

    s = "cat"
    s0 = s[](0)

    print s0[0]
    print s[1]

---

### Function Names Without Parentheses

Function names can be used without parentheses `()` until a variable of the same name is created.

Example:

    myFunc():
    @ 1

    print myFunc

    Output: 1

When a variable of the same name is given, the output changes.

Example:

    myFunc():
    @ 2

    myFunc = 3

    print myFunc

    Output: 3

The function can be specified explicitly, if required.

Example:

    myFunc():
    @ 3

    myFunc = 9

    print myFunc()

    Output: 3

---

### Printed Functions Still Execute

When a function is used with the `print` command, the system will execute the function. This can lead to some side-effects compared to compiled language code.

Example:

    myFunc():
     print 4
    @ 5

    print myFunc()

    Output:
        4
        5

This example shows the print command inside `myFunc()` being executed before the return value is shown.
