terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      # A dev stage must be destroyable and re-creatable under the same name.
      purge_soft_delete_on_destroy = true
    }
  }

  subscription_id = var.subscription_id
}
