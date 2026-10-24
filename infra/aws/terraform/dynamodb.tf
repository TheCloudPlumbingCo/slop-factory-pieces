# Layout is documented in infra/aws/src/DynamoMailboxTable.ts: partition key `pk`; the sparse GSI `due-index`
# holds only mailboxes waiting to be looked at, keys only (the sweep reads just `pk` from it); dedup items carry a
# `ttl` (epoch seconds).
resource "aws_dynamodb_table" "mailbox" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "due"
    type = "S"
  }

  attribute {
    name = "dueAt"
    type = "N"
  }

  global_secondary_index {
    name            = "due-index"
    projection_type = "KEYS_ONLY"

    key_schema {
      attribute_name = "due"
      key_type       = "HASH"
    }

    key_schema {
      attribute_name = "dueAt"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
