"""Create only fictitious records in the dedicated App Review database."""

import json
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def api(path, data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(
        "http://127.0.0.1:18087" + path,
        data=None if data is None else json.dumps(data).encode(),
        headers=headers,
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def login(name, password):
    return api("/api/auth/staff/login", {"account": name, "password": password})


def main():
    health = api("/healthz")
    if health["database"] != "kunlun_review" or health["dbUser"] != "kunlun_review_app":
        raise RuntimeError("Wrong database for App Review fixtures.")
    admin = login("review_admin", os.environ["REVIEW_ADMIN_PASSWORD"])["accessToken"]
    password = os.environ["REVIEW_STAFF_PASSWORD"]
    staff = api("/api/staff", token=admin)
    if not any(entry["username"] == "apple_review" for entry in staff):
        api("/api/staff", {
            "name": "审核演示店员", "phone": "10000000000", "username": "apple_review",
            "password": password, "role": "CLERK",
        }, admin)
    reviewer = login("apple_review", password)
    if reviewer["role"] != "CLERK":
        raise RuntimeError("App Review account must be a clerk.")

    plans = api("/api/plans", token=admin)
    fixtures = [
        ("演示会员陈女士", "10000000001", "演示小区 1 栋", "BUCKET_18_9L", "DELIVERY", "BUCKET", 2),
        ("演示会员周先生", "10000000002", "演示小区 2 栋", "BUCKET_18_9L", "PICKUP", "BUCKET", 1),
        ("演示会员林女士", "10000000003", "演示小区 3 栋", "BAG_7_5L", "PICKUP", "BAG", 3),
    ]
    for container in ("BUCKET", "BAG"):
        api("/api/containers/inventory", {
            "containerType": container, "action": "RECEIVE", "quantity": 150,
            "reason": "审核环境演示库存", "idempotencyKey": "review-stock-" + container,
        }, admin)

    for name, phone, address, water, mode, container, quantity in fixtures:
        members = api("/api/members?" + urlencode({"q": phone}), token=admin)
        member = next((row for row in members if row["phone"] == phone), None)
        if member is None:
            member = api("/api/members", {
                "name": name, "phone": phone, "defaultAddress": address, "doorNo": "101 室",
            }, admin)
        plan = next(entry for entry in plans if entry["waterType"] == water
                    and entry["fulfillMode"] == mode and entry["price"] == 100
                    and entry["status"] == "ACTIVE")
        api("/api/recharges", {
            "memberId": member["id"], "planId": plan["id"], "payMethod": "CASH",
            "idempotencyKey": "review-recharge-" + phone,
        }, admin)
        api("/api/deposits/collect", {
            "memberId": member["id"], "containerType": container, "quantity": 1,
            "payMethod": "CASH", "idempotencyKey": "review-deposit-" + phone,
        }, admin)
        api("/api/orders", {
            "memberId": member["id"], "waterType": water, "fulfillMode": mode, "orderQty": quantity,
            "remark": "审核演示水单", "idempotencyKey": "review-order-" + phone,
        }, admin)

    members = api("/api/members", token=reviewer["accessToken"])
    orders = api("/api/orders", token=reviewer["accessToken"])
    if not {fixture[1] for fixture in fixtures}.issubset({member["phone"] for member in members}) or len(orders) < 3:
        raise RuntimeError("Reviewer cannot see the demonstration fixtures.")
    print("审核环境：店员登录验证通过，演示会员和配送、自提订单已就绪。")


if __name__ == "__main__":
    main()
