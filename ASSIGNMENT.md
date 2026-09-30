# Quantitative Developer Take-Home Assignment

**Timebox:** One day  
**Format:** Individual, open-book, AI-enabled

## Background

Quantitative strategies often use candlestick data, also called klines. Depending entirely on exchange-generated klines can introduce delays and uncertainty around recent values. An alternative is to consume a stream of executed trades and construct klines locally.

We want to understand how you approach this as an engineering problem: how you investigate unfamiliar tools, define sensible behavior, design a system, verify your work, and use AI effectively.

## Goal

Build a small market-data service that constructs **one-minute klines from streamed trade data** and makes the results available to downstream consumers.

You decide the architecture, implementation, interfaces, and scope. Consider how the service should behave under realistic operating conditions—not just an ideal demonstration. State your assumptions and explain the important decisions and trade-offs.

Before the assignment, we will ask whether you have VPN access. With VPN access and a reachable Binance endpoint, you may use Binance public trade data for your initial implementation. Otherwise, use a mock-data supplier.

**Regardless of whether you use live data, build a mock-data supplier** that lets you simulate normal activity and relevant edge cases. Identifying those cases and demonstrating how your system handles them are part of the assignment. Live exchange access is not a grading advantage.

## Approach and Resources

Use any tools and resources available to you, including AI assistants, coding agents, documentation, web searches, existing libraries, frameworks, and open-source projects. **Do not obtain help from other people.** Existing public material is allowed; asking someone else to design, implement, review, or debug your submission is not.

Reuse is encouraged. You do not need to implement everything yourself, and reinventing established functionality is not a goal. Consider established infrastructure, such as Redis, where it serves a clear purpose. No particular library or infrastructure choice is required or earns points by itself.

Identify significant reused components and their sources. You remain responsible for understanding, integrating, and verifying everything you submit, including AI-generated code.

## How We Assess Your Work

We assess both the submitted system and the engineering process behind it.

| Quality | What we look for |
| --- | --- |
| **Functional correctness** | A useful implementation, clear assumptions, and evidence that the output and behavior can be trusted. |
| **System design** | Sound decisions about component boundaries, concurrency, state, data flow, failures, and scaling. Complexity should have a reason. |
| **Code quality and maintainability** | Readable, well-structured code that another engineer can understand, run, and modify. |
| **Testing and verification** | Meaningful tests, realistic simulated conditions, and independent checks—not just a successful happy-path run. |
| **Learning and engineering judgment** | Effective investigation of unfamiliar tools, appropriate reuse, sensible prioritization, and clear trade-offs within the timebox. |
| **AI-native workflow** | Effective use of AI for investigation, implementation, testing, and review, with evidence that you critically evaluate its output and make your work easy to continue. |

We do not reward technology count, code volume, prompt volume, or unnecessary infrastructure. Explain what you built, why you chose that approach, what you verified, and where uncertainty remains.

## Submission

Submit:

1. **A ZIP archive of your project**, including the mock-data supplier, tests, instructions for running and evaluating the work, and brief notes on your design, assumptions, reused components, and known limitations.
2. **The AI chat history for this assignment**, covering the tools and sessions you used. Native exports or readable transcripts are acceptable, either inside the ZIP or as separate files. Redact credentials, secrets, and unrelated personal or confidential information while preserving the relevant technical exchanges.

**An incomplete submission is acceptable and will still be graded.** At the end of the timebox, submit what you have. Clearly distinguish what works, what has been tested, what is unfinished, and what you would do next. Do not present planned or unverified behavior as implemented functionality.
