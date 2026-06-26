#!/bin/sh
rsync -e "ssh -i ~/.ssh/aws.pem" -avz \
	--exclude node_modules \
	--exclude .git \
	--exclude .venv \
	--exclude dist \
	--exclude backend/__pycache__ \
	. ec2-user@18.246.249.76:/home/ec2-user/llm-night-watch/
