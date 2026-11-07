import os
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from aiide_sdk.langchain import AIIDECallbackHandler
from aiide_sdk import flush


@tool
def project_facts() -> str:
    """Return facts about this IDE."""
    return "The IDE stores telemetry locally. Cloud services are optional."


model = ChatOpenAI(base_url=os.getenv("AIIDE_MODEL_URL", "http://localhost:11434/v1"),
                   model=os.getenv("AIIDE_MODEL_NAME", "qwen3:8b"), api_key=os.getenv("AIIDE_MODEL_KEY", "local"))
agent = create_react_agent(model, [project_facts])
result = agent.invoke({"messages": [("user", "Use project_facts to describe the telemetry default.")]},
                      config={"callbacks": [AIIDECallbackHandler()], "recursion_limit": 12})
print(result["messages"][-1].content)
flush()
