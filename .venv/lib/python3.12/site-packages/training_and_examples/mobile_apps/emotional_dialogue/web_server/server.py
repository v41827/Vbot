import io
import json
import os
import sys
import uuid
from subprocess import call

import requests
import urllib3
from flask import Flask, Response, jsonify, request, send_file
from flask_cors import CORS

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)
CORS(app)


@app.route("/")
def status_check():
    return "Server is running"


if True:
    import os

    import httpx
    from openai import OpenAI

    os.environ["OPENAI_API_KEY"] = (
        ""  # use your openai credentials or repace this block tu your LLM
    )
    os.environ["OPENAI_PROXY_URL"] = ""

    proxy_url = os.environ.get("OPENAI_PROXY_URL")
    client = (
        OpenAI()
        if proxy_url is None or proxy_url == ""
        else OpenAI(http_client=httpx.Client(proxy=proxy_url))
    )
    print(client)

    model_name = "gpt-4o"

    def get_completion(content):
        response = client.chat.completions.create(
            model=model_name, messages=[{"role": "user", "content": content}], temperature=0
        )
        return response.choices[0].message.content

    def get_completion_from_messages(messages):
        response = client.chat.completions.create(
            model=model_name, messages=messages, temperature=0
        )
        return response.choices[0].message.content


emotions = ["happy", "sad", "fear", "angry"]
emotion_prompt = "What is the {} one-paragraph response to "
additional_emotion_prompt = "What is the {} one-paragraph response to the initial question?"
aggregation_prompt = "Aggregate the answers to form a final response "
user_emotion_prompt = ". Take into account that I am {} now."


def get_emotion_prompt(emotion, prompt):
    return emotion_prompt.format(emotion) + prompt


def get_additional_emotion_prompt(emotion):
    return additional_emotion_prompt.format(emotion)


def get_aggregation_prompt(user_emotion):
    return (
        aggregation_prompt
        if user_emotion == "neutral"
        else aggregation_prompt + user_emotion_prompt.format(user_emotion)
    )


def process_multiple_emotional_agents2(question, user_emotion="neutral"):
    ai_answers = {}
    messages = []
    for i, emotion in enumerate(emotions):
        if i == 0:
            messages.append({"role": "user", "content": get_emotion_prompt(emotion, question)})
        else:
            messages.append({"role": "user", "content": get_additional_emotion_prompt(emotion)})
        assistant = get_completion_from_messages(messages)
        messages.append({"role": "assistant", "content": assistant})
        print(emotion, assistant, "\n\n")
        ai_answers[emotion] = assistant
        # time.sleep(delay)

    messages.append({"role": "user", "content": get_aggregation_prompt(user_emotion)})
    assistant = get_completion_from_messages(messages)
    print("Summary:", assistant)
    ai_answers["Summary"] = assistant
    return ai_answers
    # ai_answer="Summary (user emotion "+user_emotion+"): "+assistant


@app.route("/insideout", methods=["POST"])
def process_insideout_request():
    content = request.json
    print(content)
    # photo = request.files['photo'].read()
    question = content["question"]
    user_emotion = content["userEmotion"]
    ai_answers = process_multiple_emotional_agents2(question, user_emotion)
    return Response(response=json.dumps(ai_answers), status=200, mimetype="application/json")


@app.route("/single", methods=["POST"])
def process_single_request():
    content = request.json
    # print(content)
    question = content["question"]
    user_emotion = content["userEmotion"]
    prompt = get_emotion_prompt(user_emotion, question)
    # if user_emotion!='neutral':
    #    prompt+=user_emotion_prompt.format(user_emotion)
    assistant = get_completion(prompt)
    print(prompt, "\n", assistant)
    ai_answers = {"Summary": assistant}
    return Response(response=json.dumps(ai_answers), status=200, mimetype="application/json")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050)
