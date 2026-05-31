Add a new load-balancing logic (alogn side the strict priority and weight LL): Latency-ordered, whereby the provider with the lowest TTFB latency is always used. This requires TTFB load-average computation (over the last 10 minutes - configurable in Config). In the case where no data exists for this LL method, then it equals to LL with equal weights.

To improve UX in the Metrics panel, let's show all the graphs together in the same page, so there is no need for a dropdown to select the metric. But add buttons to jump directly to the desired graph (like ToC in a document).


We need to fix Metrics panel to avoid confusion due to double counting e.g. when "ALL" is selected in the model selector, tokens from componsite models and those primary ones registered under the composite are double counted. The UI show allow for selecting between (or all) primary models OR selecting between (or all) composite models. The most flexible way would be to have the model dropdown be a tree, with top level categories "Primary" and "Composite", and then the models listed under each category, and an "ALL" option for each category as well. Unless you have a better idea.




- Test the other providers (all of them)
  
- Port gemini back to llm-router
- Test with copilot