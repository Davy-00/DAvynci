import os
import sys

import resend


def main() -> int:
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    to_email = os.getenv("RESEND_TO_EMAIL", "").strip()
    from_email = os.getenv("RESEND_FROM_EMAIL", "bebisday@gmail.com").strip()

    if not api_key:
        print("Missing RESEND_API_KEY")
        return 1
    if not to_email:
        print("Missing RESEND_TO_EMAIL")
        return 1

    resend.api_key = api_key

    result = resend.Emails.send(
        {
            "from": from_email,
            "to": to_email,
            "subject": "DAvynci Signal Test",
            "html": "<p>Resend integration is working for <strong>DAvynci</strong>.</p>",
        }
    )
    print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
