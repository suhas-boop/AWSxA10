"""Preflight: is Bedrock reachable, and does the model call tools?  python check_bedrock.py

Uses AWS_BEARER_TOKEN_BEDROCK (Bedrock API key) or standard AWS credentials,
plus BEDROCK_MODEL_ID / AWS_REGION (defaults: us.anthropic.claude-sonnet-5, us-east-2).
"""
import os
import sys

from hospiceprint.llm_agent import DEFAULT_MODEL, DEFAULT_REGION, BedrockLLM


def main():
    print(f"model  {DEFAULT_MODEL}\nregion {DEFAULT_REGION}")
    print(f"auth   {'Bedrock API key' if os.environ.get('AWS_BEARER_TOKEN_BEDROCK') else 'AWS credentials chain'}")
    try:
        llm = BedrockLLM()
    except ImportError:
        sys.exit("FAIL  boto3 not installed: pip install -r requirements.txt")
    tool = [{"toolSpec": {"name": "get_time", "description": "Returns the current time.",
                          "inputSchema": {"json": {"type": "object", "properties": {}}}}}]
    try:
        r = llm.converse([{"role": "user", "content": [{"text": "What time is it? Use the tool."}]}],
                         tool, "You are a test harness. Call the tool.")
    except Exception as exc:
        sys.exit(f"FAIL  {type(exc).__name__}: {exc}")
    blocks = r["output"]["message"]["content"]
    if any("toolUse" in b for b in blocks):
        print("PASS  model answered and requested a tool call - live mode will work")
    else:
        text = " ".join(b.get("text", "") for b in blocks)
        print(f"WARN  model answered but did not call a tool: {text[:120]!r}")


if __name__ == "__main__":
    main()
