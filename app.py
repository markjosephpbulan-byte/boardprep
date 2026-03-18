from flask import Flask, jsonify, request, send_from_directory
import json
import os
import uuid
from datetime import datetime

app = Flask(__name__, static_folder="static")
DATA_FILE = os.environ.get("DATA_FILE", "data.json")


def load_data():
    if not os.path.exists(DATA_FILE):
        return {"subjects": [], "notes": []}
    with open(DATA_FILE, "r") as f:
        return json.load(f)


def save_data(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def init_data():
    if not os.path.exists(DATA_FILE):
        save_data({"subjects": [], "notes": []})


init_data()

# ── Subjects ──────────────────────────────────────────────────────────────────


@app.route("/api/subjects", methods=["GET"])
def get_subjects():
    data = load_data()
    return jsonify(data["subjects"])


@app.route("/api/subjects", methods=["POST"])
def add_subject():
    data = load_data()
    body = request.json
    subject = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "color": body.get("color", "#4f8ef7"),
        "subsections": [],
        "created_at": datetime.now().isoformat(),
    }
    data["subjects"].append(subject)
    save_data(data)
    return jsonify(subject), 201


@app.route("/api/subjects/<subject_id>", methods=["PUT"])
def update_subject(subject_id):
    data = load_data()
    body = request.json
    for s in data["subjects"]:
        if s["id"] == subject_id:
            s["name"] = body.get("name", s["name"])
            s["color"] = body.get("color", s["color"])
            save_data(data)
            return jsonify(s)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/subjects/<subject_id>", methods=["DELETE"])
def delete_subject(subject_id):
    data = load_data()
    data["subjects"] = [s for s in data["subjects"] if s["id"] != subject_id]
    save_data(data)
    return jsonify({"ok": True})


# ── Subsections ───────────────────────────────────────────────────────────────


@app.route("/api/subjects/<subject_id>/subsections", methods=["POST"])
def add_subsection(subject_id):
    data = load_data()
    body = request.json
    subsection = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "done": False,
        "topics": [],
        "created_at": datetime.now().isoformat(),
    }
    for s in data["subjects"]:
        if s["id"] == subject_id:
            s["subsections"].append(subsection)
            save_data(data)
            return jsonify(subsection), 201
    return jsonify({"error": "Not found"}), 404


@app.route("/api/subjects/<subject_id>/subsections/<sub_id>", methods=["PUT"])
def update_subsection(subject_id, sub_id):
    data = load_data()
    body = request.json
    for s in data["subjects"]:
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    ss["name"] = body.get("name", ss["name"])
                    ss["done"] = body.get("done", ss["done"])
                    save_data(data)
                    return jsonify(ss)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/subjects/<subject_id>/subsections/<sub_id>", methods=["DELETE"])
def delete_subsection(subject_id, sub_id):
    data = load_data()
    for s in data["subjects"]:
        if s["id"] == subject_id:
            s["subsections"] = [ss for ss in s["subsections"] if ss["id"] != sub_id]
            save_data(data)
            return jsonify({"ok": True})
    return jsonify({"error": "Not found"}), 404


# ── Topics ────────────────────────────────────────────────────────────────────


@app.route("/api/subjects/<subject_id>/subsections/<sub_id>/topics", methods=["POST"])
def add_topic(subject_id, sub_id):
    data = load_data()
    body = request.json
    topic = {
        "id": str(uuid.uuid4()),
        "name": body["name"],
        "done": False,
        "created_at": datetime.now().isoformat(),
    }
    for s in data["subjects"]:
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    ss["topics"].append(topic)
                    save_data(data)
                    return jsonify(topic), 201
    return jsonify({"error": "Not found"}), 404


@app.route(
    "/api/subjects/<subject_id>/subsections/<sub_id>/topics/<topic_id>", methods=["PUT"]
)
def update_topic(subject_id, sub_id, topic_id):
    data = load_data()
    body = request.json
    for s in data["subjects"]:
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    for t in ss["topics"]:
                        if t["id"] == topic_id:
                            t["name"] = body.get("name", t["name"])
                            t["done"] = body.get("done", t["done"])
                            save_data(data)
                            return jsonify(t)
    return jsonify({"error": "Not found"}), 404


@app.route(
    "/api/subjects/<subject_id>/subsections/<sub_id>/topics/<topic_id>",
    methods=["DELETE"],
)
def delete_topic(subject_id, sub_id, topic_id):
    data = load_data()
    for s in data["subjects"]:
        if s["id"] == subject_id:
            for ss in s["subsections"]:
                if ss["id"] == sub_id:
                    ss["topics"] = [t for t in ss["topics"] if t["id"] != topic_id]
                    save_data(data)
                    return jsonify({"ok": True})
    return jsonify({"error": "Not found"}), 404


# ── Notes ─────────────────────────────────────────────────────────────────────


@app.route("/api/notes", methods=["GET"])
def get_notes():
    data = load_data()
    return jsonify(data.get("notes", []))


@app.route("/api/notes", methods=["POST"])
def add_note():
    data = load_data()
    body = request.json
    note = {
        "id": str(uuid.uuid4()),
        "title": body.get("title", "Untitled"),
        "content": body.get("content", ""),
        "color": body.get("color", "#fef08a"),
        "subject_id": body.get("subject_id", None),
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    data.setdefault("notes", []).append(note)
    save_data(data)
    return jsonify(note), 201


@app.route("/api/notes/<note_id>", methods=["PUT"])
def update_note(note_id):
    data = load_data()
    body = request.json
    for n in data.get("notes", []):
        if n["id"] == note_id:
            n["title"] = body.get("title", n["title"])
            n["content"] = body.get("content", n["content"])
            n["color"] = body.get("color", n["color"])
            n["updated_at"] = datetime.now().isoformat()
            save_data(data)
            return jsonify(n)
    return jsonify({"error": "Not found"}), 404


@app.route("/api/notes/<note_id>", methods=["DELETE"])
def delete_note(note_id):
    data = load_data()
    data["notes"] = [n for n in data.get("notes", []) if n["id"] != note_id]
    save_data(data)
    return jsonify({"ok": True})


# ── Serve frontend ────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
